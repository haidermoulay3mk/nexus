import type { RunContext } from "@nexus/plugin-sdk";
import { z } from "zod";
import type { ChatService } from "./chat";
import { type BrainStore, MEMORY_TYPES, redLineViolation } from "./store";

/**
 * End-of-session memory extraction — the only place a model proposes
 * writes, and every proposal passes through code gates before touching
 * disk: Zod shape validation → red-line filter → dedupe. Best-effort by
 * design: a failed parse or an offline model just leaves the session for
 * the next attempt. It can never corrupt anything.
 */

const Candidate = z.object({
  type: z.enum(MEMORY_TYPES),
  hook: z.string().min(8).max(120),
  body: z.string().min(1).max(600),
});
export type Candidate = z.infer<typeof Candidate>;

export const MIN_TURNS = 4;
export const MIN_CHARS = 200;
export const MAX_MEMORIES_PER_SESSION = 3;

/** Tolerant JSON-array recovery from small-model output. Exported for tests. */
export function parseExtractorReply(text: string): Candidate[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const out: Candidate[] = [];
    for (const item of parsed.slice(0, MAX_MEMORIES_PER_SESSION)) {
      const c = Candidate.safeParse(item);
      if (c.success) out.push(c.data);
    }
    return out;
  } catch {
    return [];
  }
}

/** True when most user turns are typed commands — nothing worth remembering. */
export function looksLikeCommands(transcript: string, prefixes: string[]): boolean {
  const userLines = transcript.split("\n").filter((l) => l.startsWith("USER:"));
  if (userLines.length === 0) return false;
  const commandish = userLines.filter((l) => {
    const first = (l.split(":").slice(1).join(":").trim().split(/\s+/)[0] ?? "").toLowerCase();
    return prefixes.includes(first);
  });
  return commandish.length / userLines.length > 0.7;
}

const PROMPT_HEADER = `You extract durable long-term memories from a conversation transcript.
Reply with ONLY a JSON array — no prose, no markdown fences. Each item:
{"type":"user"|"preference"|"project"|"reference","hook":"<one line, max 90 chars>","body":"<why it matters and how to apply it>"}

KEEP only facts that will still matter weeks from now: things the operator
taught or corrected, stated preferences on how to work, project decisions,
useful external resources.
NEVER keep: transient task state, questions, small talk, testing chatter,
health or personal-life matters, money amounts, secrets or credentials.
If nothing qualifies, reply [].

TRANSCRIPT:
`;

export interface ExtractOutcome {
  saved: string[]; // hooks written
  note: string; // what happened, for the wire/audit trail
}

export async function extractSession(
  deps: { chat: ChatService; store: BrainStore; commandPrefixes: () => string[] },
  ctx: RunContext,
  sessionId: string,
): Promise<ExtractOutcome> {
  const depth = deps.chat.depth(sessionId);
  const transcript = deps.chat.transcript(sessionId);

  if (depth < MIN_TURNS || transcript.length < MIN_CHARS) {
    deps.chat.markExtracted(sessionId, "skipped: too short");
    return { saved: [], note: "skipped — too short to matter" };
  }
  if (looksLikeCommands(transcript, deps.commandPrefixes())) {
    deps.chat.markExtracted(sessionId, "skipped: command traffic");
    return { saved: [], note: "skipped — command traffic, not conversation" };
  }

  const reply = await ctx.llm.complete(PROMPT_HEADER + transcript, { maxTokens: 500 });
  if (!reply.ok) {
    // Model offline → leave the session unmarked; next boot retries.
    return {
      saved: [],
      note: `deferred — model unavailable (${reply.error.message.slice(0, 60)})`,
    };
  }

  const candidates = parseExtractorReply(reply.value);
  if (candidates.length === 0) {
    deps.chat.markExtracted(sessionId, "nothing durable");
    return { saved: [], note: "nothing durable found" };
  }

  const saved: string[] = [];
  for (const c of candidates) {
    if (redLineViolation(`${c.hook}\n${c.body}`)) continue; // code gate, model opinion irrelevant
    const res = await deps.store.save(c.type, c.hook, c.body);
    if (res.saved) saved.push(c.hook);
  }
  deps.chat.markExtracted(sessionId, `saved ${saved.length}/${candidates.length}`);
  return {
    saved,
    note:
      saved.length > 0 ? `remembered ${saved.length}` : "candidates were duplicates or red-lined",
  };
}
