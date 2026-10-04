import { randomUUID } from "node:crypto";
import type { DbHandle } from "@nexus/db";
import { memories, memoryVectors, messages, runs, sessions } from "@nexus/db";
import { decodeEmbedding, encodeEmbedding } from "@nexus/db";
import type { MemoryApi, MemoryHit } from "@nexus/plugin-sdk";
import { desc, eq, inArray } from "drizzle-orm";
import type { OllamaService } from "../ai/ollama";

/**
 * The 4-layer memory system.
 *
 *  1. WORKING    — rolling, token-budgeted conversation buffer (messages)
 *  2. SEMANTIC   — embedded facts/notes with vector retrieval (sqlite-vec)
 *  3. STRUCTURED — durable typed facts / preferences / entities
 *  4. EPISODIC   — every run is logged and searchable (runs / run_steps)
 *
 * Reachable only through typed tools — agents never touch SQL.
 */
export class MemoryService implements MemoryApi {
  constructor(
    private readonly handle: DbHandle,
    private readonly ollama: OllamaService,
  ) {}

  /* ---------------- semantic + structured ---------------- */

  async write(
    kind: "fact" | "pref" | "entity" | "note",
    text: string,
    source: string,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.handle.db.insert(memories).values({ id, kind, text, source, createdAt: now }).run();

    // Embed best-effort: if the embed model is missing we still keep the
    // memory (searchable via recent()); vectors backfill on next search.
    const emb = await this.ollama.embed([text]);
    if (emb.ok && emb.value[0]) {
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
    }
    return id;
  }

  async search(query: string, k = 6): Promise<MemoryHit[]> {
    const emb = await this.ollama.embed([query]);
    if (!emb.ok || !emb.value[0]) {
      // Embeddings unavailable → keyword overlap, then recency. Recall
      // degrades; it never goes blind.
      const kw = this.keywordSearch(query, k);
      return kw.length > 0 ? kw : this.recent(undefined, k);
    }
    await this.backfillMissingVectors();
    const hits = this.handle.vec.search(emb.value[0], k);
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.memoryId);
    const rows = this.handle.db.select().from(memories).where(inArray(memories.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: MemoryHit[] = [];
    for (const h of hits) {
      const m = byId.get(h.memoryId);
      if (m)
        out.push({ id: m.id, kind: m.kind, text: m.text, source: m.source, distance: h.distance });
    }
    return out;
  }

  /** Zero-dependency fallback ranking: shared-word count, ties → newer. */
  keywordSearch(query: string, k = 6): MemoryHit[] {
    const terms = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
    if (terms.size === 0) return [];
    const rows = this.handle.db.select().from(memories).orderBy(desc(memories.createdAt)).all();
    const scored = rows
      .map((m) => {
        const words = new Set(m.text.toLowerCase().split(/[^a-z0-9]+/));
        let overlap = 0;
        for (const t of terms) if (words.has(t)) overlap += 1;
        return { m, overlap };
      })
      .filter((s) => s.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, k);
    return scored.map(({ m, overlap }) => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      source: m.source,
      // pseudo-distance so callers can still threshold: more overlap = closer
      distance: 1 / (1 + overlap),
    }));
  }

  async recent(kind?: string, limit = 10): Promise<MemoryHit[]> {
    const rows = kind
      ? this.handle.db
          .select()
          .from(memories)
          .where(eq(memories.kind, kind))
          .orderBy(desc(memories.createdAt))
          .limit(limit)
          .all()
      : this.handle.db.select().from(memories).orderBy(desc(memories.createdAt)).limit(limit).all();
    return rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      source: m.source,
      distance: 1,
    }));
  }

  /** Embed any memories saved while the embed model was unavailable. */
  private async backfillMissingVectors(): Promise<void> {
    const missing = this.handle.sqlite
      .query(
        `SELECT m.id, m.text FROM memories m
          LEFT JOIN memory_vectors v ON v.memory_id = m.id
         WHERE v.memory_id IS NULL LIMIT 32`,
      )
      .all() as Array<{ id: string; text: string }>;
    if (missing.length === 0) return;
    const emb = await this.ollama.embed(missing.map((m) => m.text));
    if (!emb.ok) return;
    missing.forEach((m, i) => {
      const v = emb.value[i];
      if (!v) return;
      this.handle.db
        .insert(memoryVectors)
        .values({ memoryId: m.id, embedding: encodeEmbedding(v), dims: v.length })
        .onConflictDoNothing()
        .run();
      this.handle.vec.upsert(m.id, v);
    });
  }

  /* ---------------- working memory ---------------- */

  private readonly WORKING_SESSION = "working";
  private readonly WORKING_BUDGET_TOKENS = 2_000;

  appendWorking(role: "user" | "assistant" | "system", content: string): void {
    const now = new Date().toISOString();
    const db = this.handle.db;
    const existing = db.select().from(sessions).where(eq(sessions.id, this.WORKING_SESSION)).all();
    if (existing.length === 0) {
      db.insert(sessions)
        .values({
          id: this.WORKING_SESSION,
          title: "Working buffer",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    const tokens = Math.ceil(content.length / 4); // cheap heuristic, fine for budgeting
    db.insert(messages)
      .values({
        id: randomUUID(),
        sessionId: this.WORKING_SESSION,
        role,
        content,
        tokens,
        createdAt: now,
      })
      .run();
    this.trimWorking();
  }

  workingBuffer(): Array<{ role: string; content: string }> {
    return this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, this.WORKING_SESSION))
      .orderBy(messages.createdAt)
      .all()
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private trimWorking(): void {
    const rows = this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, this.WORKING_SESSION))
      .orderBy(desc(messages.createdAt))
      .all();
    let budget = this.WORKING_BUDGET_TOKENS;
    const evict: string[] = [];
    for (const r of rows) {
      budget -= r.tokens;
      if (budget < 0) evict.push(r.id);
    }
    if (evict.length > 0) {
      this.handle.db.delete(messages).where(inArray(messages.id, evict)).run();
    }
  }

  /* ---------------- episodic ---------------- */

  recentRuns(limit = 20): Array<{
    id: string;
    intentKey: string;
    agent: string;
    status: string;
    createdAt: string;
    error: string | null;
  }> {
    return this.handle.db
      .select({
        id: runs.id,
        intentKey: runs.intentKey,
        agent: runs.agent,
        status: runs.status,
        createdAt: runs.createdAt,
        error: runs.error,
      })
      .from(runs)
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .all();
  }
}

export { decodeEmbedding };
