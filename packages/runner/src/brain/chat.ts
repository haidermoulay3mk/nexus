import { randomUUID } from "node:crypto";
import type { DbHandle } from "@nexus/db";
import { messages, sessions, settings } from "@nexus/db";
import { desc, eq } from "drizzle-orm";

/**
 * Conversational working memory: free-text ⌘K/voice exchanges are organized
 * into SESSIONS persisted turn-by-turn, so "what we were just doing"
 * survives a restart. The active window sent to the model is token-bounded;
 * the full transcript stays in SQLite for the extractor and for `session
 * resume`.
 *
 * Session rotation: a gap longer than SESSION_IDLE_MIN starts a fresh
 * session (and hands the finished one to the memory extractor).
 */

export const SESSION_IDLE_MIN = 45;
export const HISTORY_BUDGET_TOKENS = 1_100;
/** conversation depth at which the personality checkpoint kicks in */
export const CHECKPOINT_DEPTH = 12;

const ACTIVE_KEY = "brain.activeSession";
/** reserved by MemoryService's rolling buffer — never treated as a chat */
const RESERVED = new Set(["working"]);

export interface ChatTurn {
  role: string;
  content: string;
  createdAt: string;
}

const now = () => new Date().toISOString();

export class ChatService {
  constructor(private readonly handle: DbHandle) {}

  /** The active session — reused within the idle window, else rotated.
   *  `rotatedFrom` names the finished session so callers can trigger the
   *  memory extractor on it. */
  current(firstInput?: string): { id: string; rotatedFrom: string | null } {
    const activeId = this.getSetting(ACTIVE_KEY);
    if (activeId) {
      const last = this.lastMessageAt(activeId);
      if (last && Date.now() - new Date(last).getTime() < SESSION_IDLE_MIN * 60_000) {
        return { id: activeId, rotatedFrom: null };
      }
    }
    const id = randomUUID();
    const title = (firstInput ?? "Conversation").slice(0, 48);
    this.handle.db.insert(sessions).values({ id, title, createdAt: now(), updatedAt: now() }).run();
    this.setSetting(ACTIVE_KEY, id);
    const rotatedFrom = activeId && this.depth(activeId) > 0 ? activeId : null;
    return { id, rotatedFrom };
  }

  append(sessionId: string, role: "user" | "assistant", content: string): void {
    this.handle.db
      .insert(messages)
      .values({
        id: randomUUID(),
        sessionId,
        role,
        content,
        tokens: Math.ceil(content.length / 4),
        createdAt: now(),
      })
      .run();
    this.handle.db
      .update(sessions)
      .set({ updatedAt: now() })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  /** Most recent turns that fit the token budget, oldest → newest. */
  window(sessionId: string, budgetTokens = HISTORY_BUDGET_TOKENS): ChatTurn[] {
    const rows = this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .all();
    const out: ChatTurn[] = [];
    let budget = budgetTokens;
    for (const r of rows) {
      budget -= r.tokens;
      if (budget < 0) break;
      out.push({ role: r.role, content: r.content, createdAt: r.createdAt });
    }
    return out.reverse();
  }

  depth(sessionId: string): number {
    return this.handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .all().length;
  }

  listRecent(limit = 6): Array<{ id: string; title: string; updatedAt: string; turns: number }> {
    return this.handle.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt))
      .limit(limit + RESERVED.size)
      .all()
      .filter((s) => !RESERVED.has(s.id))
      .slice(0, limit)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, turns: this.depth(s.id) }));
  }

  /** Switch back into a recent session by id prefix. */
  resume(idPrefix: string): { ok: boolean; id?: string; title?: string } {
    const hit = this.handle.db
      .select()
      .from(sessions)
      .all()
      .find((s) => s.id.startsWith(idPrefix) && !RESERVED.has(s.id));
    if (!hit) return { ok: false };
    this.setSetting(ACTIVE_KEY, hit.id);
    // Reopening a thread makes it live again; it will re-extract when it
    // next goes idle.
    this.handle.db
      .update(sessions)
      .set({ updatedAt: now(), extractedAt: null })
      .where(eq(sessions.id, hit.id))
      .run();
    return { ok: true, id: hit.id, title: hit.title };
  }

  /** Force a fresh session (typed `session new`). */
  startNew(): { id: string; rotatedFrom: string | null } {
    const activeId = this.getSetting(ACTIVE_KEY);
    this.setSetting(ACTIVE_KEY, "");
    const fresh = this.current("Conversation");
    return { id: fresh.id, rotatedFrom: activeId && this.depth(activeId) > 0 ? activeId : null };
  }

  /* -------- extractor bookkeeping -------- */

  /** Sessions with content, never extracted, idle past the threshold. */
  pendingExtraction(idleMin = SESSION_IDLE_MIN): string[] {
    const out: string[] = [];
    for (const s of this.handle.db.select().from(sessions).all()) {
      if (RESERVED.has(s.id) || s.extractedAt) continue;
      const last = this.lastMessageAt(s.id);
      if (!last) continue;
      if (Date.now() - new Date(last).getTime() >= idleMin * 60_000) out.push(s.id);
    }
    return out;
  }

  markExtracted(sessionId: string, note: string): void {
    this.handle.db
      .update(sessions)
      .set({ extractedAt: `${now()} (${note})` })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  transcript(sessionId: string, maxChars = 6_000): string {
    const turns = this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt)
      .all();
    const text = turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  lastMessageAt(sessionId: string): string | null {
    const row = this.handle.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .all()[0];
    return row?.createdAt ?? null;
  }

  /* -------- settings helpers -------- */

  private getSetting(key: string): string | null {
    const row = this.handle.db.select().from(settings).where(eq(settings.key, key)).all()[0];
    if (!row) return null;
    try {
      const v = JSON.parse(row.valueJson) as string;
      return v || null;
    } catch {
      return null;
    }
  }

  private setSetting(key: string, value: string): void {
    const row = { key, valueJson: JSON.stringify(value) };
    this.handle.db
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({ target: settings.key, set: row })
      .run();
  }
}
