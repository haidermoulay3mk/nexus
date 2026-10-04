import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "@nexus/db";
import { encodeEmbedding, memories, memoryVectors } from "@nexus/db";
import { eq, like } from "drizzle-orm";
import type { OllamaService } from "../ai/ollama";

/**
 * Long-term memory as individual markdown files — the source of truth a
 * human can open, edit, or delete. The `memories` DB rows and vectors for
 * these files are a DERIVED index: `reindex()` rebuilds them from disk at
 * any time, so nothing is ever lost with the database.
 *
 * File format (regex-parsed on purpose — no YAML dependency):
 *
 *   ---
 *   type: preference
 *   hook: the operator wants revision suggestions capped at three items
 *   created: 2026-07-07T20:00:00Z
 *   ---
 *
 *   body: why it matters and how to apply it…
 */

export const MEMORY_TYPES = ["user", "preference", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface BrainMemory {
  file: string;
  type: MemoryType;
  hook: string;
  body: string;
  created: string;
}

export type SaveResult = { saved: true; file: string } | { saved: false; reason: string };

/** Cosine distance below which a candidate is "the same fact" outright. */
export const DEDUPE_DISTANCE = 0.25;
/** Looser semantic band that still counts as duplicate WHEN the hooks also
 *  agree lexically — catches reworded saves of the same fact without
 *  swallowing distinct facts about the same topic. */
export const DEDUPE_DISTANCE_LOOSE = 0.55;
/** Hook word-overlap ratio for the loose band and the no-embeddings path. */
export const DEDUPE_HOOK_OVERLAP = 0.7;

/* ------------------------------------------------------------------ */
/* Red lines — enforced in CODE for every model-written memory.        */
/* The operator's own typed `brain save` may bypass (their call).      */
/* ------------------------------------------------------------------ */

const RED_LINES: Array<{ name: string; re: RegExp }> = [
  {
    name: "secrets/credentials",
    re: /\b(password|passphrase|api[_ -]?key|secret|token|credential|private key)\b/i,
  },
  {
    name: "health/personal life",
    re: /\b(health|illness|ill|sick|disease|doctor|hospital|medication|therapy|diagnos\w*|mental|anxiety|depress\w*|relationship|girlfriend|boyfriend|dating)\b/i,
  },
  {
    name: "money specifics",
    re: /(\$\s?\d|£\s?\d|€\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|dollars|euros|pounds)\b|\b(revenue|income|salary|paid|earning)s?\b[^.]{0,24}\d)/i,
  },
];

/** Returns the violated red line's name, or null if the text is clean. */
export function redLineViolation(text: string): string | null {
  for (const { name, re } of RED_LINES) if (re.test(text)) return name;
  return null;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

export function parseMemoryFile(file: string, raw: string): BrainMemory | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const head = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const field = (name: string) =>
    head.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const type = field("type") as MemoryType;
  const hook = field("hook");
  if (!MEMORY_TYPES.includes(type) || !hook) return null;
  return { file, type, hook, body, created: field("created") || "unknown" };
}

export function renderMemoryFile(m: Omit<BrainMemory, "file">): string {
  return `---\ntype: ${m.type}\nhook: ${m.hook}\ncreated: ${m.created}\n---\n\n${m.body}\n`;
}

/** Word-overlap ratio between two hooks (0..1), for embedding-less dedupe. */
export function hookOverlap(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export class BrainStore {
  readonly memoriesDir: string;

  constructor(
    private readonly handle: DbHandle,
    private readonly ollama: OllamaService,
    readonly brainDir: string,
  ) {
    this.memoriesDir = join(brainDir, "memories");
    mkdirSync(this.memoriesDir, { recursive: true });
  }

  list(): BrainMemory[] {
    const out: BrainMemory[] = [];
    for (const f of readdirSync(this.memoriesDir)) {
      if (!f.endsWith(".md") || f === "INDEX.md") continue;
      const parsed = parseMemoryFile(f, readFileSync(join(this.memoriesDir, f), "utf8"));
      if (parsed) out.push(parsed);
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }

  /**
   * Save a memory: red-line check (model path), dedupe check, file write,
   * index regeneration, DB row + vector sync. `human: true` marks the
   * operator's own typed save, which may bypass red lines — their data,
   * their call.
   */
  async save(
    type: MemoryType,
    hook: string,
    body: string,
    opts?: { human?: boolean },
  ): Promise<SaveResult> {
    const text = `${hook}\n${body}`;
    if (!opts?.human) {
      const violation = redLineViolation(text);
      if (violation) return { saved: false, reason: `red line: ${violation} is never stored` };
    }

    const dupe = await this.findDuplicate(text, hook);
    if (dupe) return { saved: false, reason: `already covered by "${dupe.hook}" (${dupe.file})` };

    let file = `${type}-${slug(hook) || "memory"}.md`;
    if (existsSync(join(this.memoriesDir, file)))
      file = `${type}-${slug(hook)}-${fnv(text).slice(0, 4)}.md`;
    const created = new Date().toISOString();
    writeFileSync(
      join(this.memoriesDir, file),
      renderMemoryFile({ type, hook, body, created }),
      "utf8",
    );

    await this.syncFile({ file, type, hook, body, created });
    this.regenIndex();
    return { saved: true, file };
  }

  /** Deletion is human-only and called by the typed `brain forget … confirm`. */
  forget(file: string): boolean {
    const path = join(this.memoriesDir, file);
    if (!existsSync(path) || !file.endsWith(".md") || file === "INDEX.md") return false;
    unlinkSync(path);
    this.removeRow(file);
    this.regenIndex();
    return true;
  }

  /** Rebuild the ENTIRE derived index (DB rows + vectors) from the files. */
  async reindex(): Promise<{ files: number; embedded: boolean }> {
    const rows = this.handle.db
      .select({ id: memories.id })
      .from(memories)
      .where(like(memories.source, "brain:%"))
      .all();
    for (const r of rows) {
      this.handle.db.delete(memoryVectors).where(eq(memoryVectors.memoryId, r.id)).run();
      this.handle.vec.remove(r.id);
      this.handle.db.delete(memories).where(eq(memories.id, r.id)).run();
    }
    const files = this.list();
    let embedded = false;
    for (const m of files) embedded = (await this.syncFile(m)) || embedded;
    this.regenIndex();
    return { files: files.length, embedded };
  }

  /** Boot-time reconciliation: index new/edited files, drop orphan rows. */
  async sync(): Promise<void> {
    const files = this.list();
    const wanted = new Map(files.map((m) => [`brain:${m.file}`, m]));
    const rows = this.handle.db
      .select()
      .from(memories)
      .where(like(memories.source, "brain:%"))
      .all();
    for (const row of rows) {
      const m = wanted.get(row.source);
      if (!m) {
        this.removeRowById(row.id);
        continue;
      }
      if (row.text === memoryText(m)) wanted.delete(row.source); // unchanged
      // changed on disk → fall through, syncFile below rewrites it
    }
    for (const m of wanted.values()) await this.syncFile(m);
    this.regenIndex();
  }

  /* ---------------- internals ---------------- */

  private async findDuplicate(text: string, hook: string): Promise<BrainMemory | null> {
    const existing = this.list();
    if (existing.length === 0) return null;

    const emb = await this.ollama.embed([text]);
    if (emb.ok && emb.value[0]) {
      const hits = this.handle.vec.search(emb.value[0], 5);
      for (const h of hits) {
        if (h.distance > DEDUPE_DISTANCE_LOOSE) continue;
        const row = this.handle.db
          .select()
          .from(memories)
          .where(eq(memories.id, h.memoryId))
          .all()[0];
        if (!row?.source.startsWith("brain:")) continue;
        const m = existing.find((x) => x.file === row.source.slice("brain:".length));
        if (!m) continue;
        // Same fact: near-identical semantics alone, or moderately close
        // semantics with lexically agreeing hooks.
        if (h.distance <= DEDUPE_DISTANCE) return m;
        if (hookOverlap(hook, m.hook) >= DEDUPE_HOOK_OVERLAP) return m;
      }
      return null;
    }
    // Embeddings down → hook word-overlap fallback.
    for (const m of existing) {
      if (hookOverlap(hook, m.hook) >= DEDUPE_HOOK_OVERLAP) return m;
    }
    return null;
  }

  /** Upsert the derived DB row + vector for one file. Returns embed success. */
  private async syncFile(m: BrainMemory): Promise<boolean> {
    const id = `brain-${fnv(m.file)}`;
    const row = {
      id,
      kind: m.type,
      text: memoryText(m),
      source: `brain:${m.file}`,
      createdAt: m.created === "unknown" ? new Date().toISOString() : m.created,
    };
    this.handle.db
      .insert(memories)
      .values(row)
      .onConflictDoUpdate({ target: memories.id, set: row })
      .run();

    const emb = await this.ollama.embed([row.text]);
    if (!emb.ok || !emb.value[0]) return false; // backfills on next search
    const v = emb.value[0];
    this.handle.db
      .insert(memoryVectors)
      .values({ memoryId: id, embedding: encodeEmbedding(v), dims: v.length })
      .onConflictDoUpdate({
        target: memoryVectors.memoryId,
        set: { embedding: encodeEmbedding(v), dims: v.length },
      })
      .run();
    this.handle.vec.upsert(id, v);
    return true;
  }

  private removeRow(file: string): void {
    const rows = this.handle.db
      .select()
      .from(memories)
      .where(eq(memories.source, `brain:${file}`))
      .all();
    for (const r of rows) this.removeRowById(r.id);
  }

  private removeRowById(id: string): void {
    this.handle.db.delete(memoryVectors).where(eq(memoryVectors.memoryId, id)).run();
    this.handle.vec.remove(id);
    this.handle.db.delete(memories).where(eq(memories.id, id)).run();
  }

  /** INDEX.md — the browsable hook list, regenerated on every change. */
  regenIndex(): void {
    const lines = [
      "# Memory Index",
      "",
      "_Generated — edit the individual files, not this list. `brain reindex` rebuilds everything._",
      "",
      ...this.list().map(
        (m) => `- **[${m.type}]** ${m.hook} — \`${m.file}\` (${m.created.slice(0, 10)})`,
      ),
    ];
    writeFileSync(join(this.memoriesDir, "INDEX.md"), `${lines.join("\n")}\n`, "utf8");
  }
}

function memoryText(m: BrainMemory): string {
  return `${m.hook}${m.body ? ` — ${m.body}` : ""}`;
}
