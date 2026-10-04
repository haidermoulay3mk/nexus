# THE BRAIN — identity, knowledge, and memory

Added in v0.3 (2026-07-08). Everything here is $0 and local: identity and
memories are markdown files, recall is nomic-embed-text in Ollama with a
keyword fallback, and every write passes through code gates — never raw
model judgment.

## Where it lives

```
~/.nexus/brain/
  identity.md          WHO Nexus is — plain prose, edit it any time
  knowledge/*.md       facts Nexus always knows (you, mission, machine, prefs)
  memories/*.md        long-term memory, one fact per file
  memories/INDEX.md    generated hook list (browse; don't edit)
```

**The files are the source of truth.** Open them, edit them, delete them —
Nexus follows on the very next reply (identity/knowledge) or after
`brain reindex` (memories). The DB rows and vectors are a derived index and
can always be rebuilt from disk.

## How Nexus thinks now (the two-block prompt)

Every agent turn sends: **[stable block]** identity + core knowledge +
auto-generated capabilities + memory discipline → **[agent role]** →
**[dynamic block]** current time (+ the personality checkpoint once a
conversation is 12+ turns deep). The stable block is byte-identical between
turns, so Ollama's prefix cache re-serves it — the full personality rides
on every turn at minimal latency cost. That constant presence is what
keeps the voice from drifting.

Free text in the palette/voice is now a real **conversation**: turns
persist to SQLite as they happen, the thread survives restarts, a 45-minute
gap starts a fresh session, and relevant memories are recalled into the
prompt automatically.

## Talking to it

- Just type in ⌘K. Nexus knows your subjects, exam dates, mission and
  preferences without being told (that's `knowledge/`).
- Teach it: say "remember: I want X" in conversation — it saves via its
  tool — or save yourself, precisely:
  `brain save preference | Status answers open with the number | Figure first, context after.`
- Types: `user` (who you are) · `preference` (how to work) · `project`
  (decisions/state) · `reference` (external resources).
- `brain recall <anything>` — paraphrases work; you don't need the original
  words.
- `session` / `session new` / `session resume <id>` — conversation threads.
- `brain` — status; `brain reindex` — rebuild index from files;
  `brain forget <file> confirm` — delete (the ONLY deletion path; no model
  can forget anything).

## Where memories come from (two ways)

1. **Deliberate:** Nexus calls its `brain.save` tool mid-conversation when
   you teach or correct it.
2. **Automatic:** when a session goes idle (45 min) or you run
   `brain extract`, a local-model pass reads the transcript and proposes
   durable facts.

Every candidate from EITHER path passes code gates, in order:
**Zod shape → red lines → dedupe.** Red lines (in `store.ts`, editable):
secrets/credentials, health/personal-life topics, money specifics. Dedupe:
near-identical semantics, or close semantics + matching hooks, is skipped
with the existing memory named. Your own typed `brain save` may bypass red
lines — your data, your call.

## Verified behavior (the tests to trust)

`bun test packages/runner/test/brain.test.ts packages/runner/test/brain-integration.test.ts`
covers: identity edits landing on the next turn with no restart; core
knowledge answering without being told; conversation surviving a full
Runner restart; files→index rebuild; paraphrase recall; keyword fallback
with embeddings down; red lines blocking; dedupe rejecting rewrites of the
same fact; the extractor writing real files and skipping small talk; the
checkpoint appearing only in deep conversations.

## When something's off

| Symptom | Fix |
|---|---|
| Voice feels wrong | Edit `~/.nexus/brain/identity.md` — next reply follows it. |
| It doesn't know something it should always know | Add a line to a `knowledge/*.md` file (or a new file there). |
| A memory is wrong/junk | `brain forget <file> confirm`, or edit the file then `brain reindex`. |
| Recall misses obvious things | Is `nomic-embed-text` pulled? (`ollama list`). Without it recall is keyword-only. Then `brain reindex`. |
| It saved something it shouldn't | Delete the file; if it's a category, add a pattern to `RED_LINES` in `packages/runner/src/brain/store.ts` (then the four gates). |
| Replies are slow | Normal on a 3B CPU model with the full brain resident (~30-60s first token). Optional free speedup: set `OLLAMA_CONTEXT_LENGTH=8192` env var and restart Ollama; the prefix cache does the rest. |
| Conversation feels amnesiac | `session` — you may have rotated; `session resume <id>`. |

## Design law (unchanged from v0.2)

The model **narrates**; code **writes**. The only model-originated writes
in all of Nexus are memory candidates, and they pass shape, red-line, and
dedupe gates in code before touching disk — and only a typed human command
can delete.
