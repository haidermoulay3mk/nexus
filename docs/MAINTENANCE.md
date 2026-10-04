# MAINTAINING NEXUS — symptom → fix runbook

For the operator, or any AI assistant helping them. **Do the recipe for the
symptom; do not refactor, "improve", or touch files the recipe doesn't
name.** After every fix, run the three checks:

```sh
bun test packages plugins    # expect: 93+ pass, 0 fail
bun run typecheck            # expect: no output after the tsc lines
bun run lint                 # expect: "Checked N files" and no errors
# then in the HUD (Ctrl+K): audit   → expect PASS
```

## Where things live

- **Code** (this repo): safe to reinstall/redownload. No user data here.
- **Data** (`C:\Users\<you>\.nexus\`): `nexus.db` (ALL tracking), `vault\`
  (markdown documents), `brain\` (your name, goals, Nexus's identity and
  memories), `secrets.enc` + `secrets.key`, `runner.token`.
  **This folder is the thing to back up** — copy it anywhere, weekly.

## Symptoms

### Nexus won't start / browser shows nothing
1. Close every Nexus window. Re-run `Start Nexus.cmd`.
2. Still dead? In a terminal, from the repo: `bun install`, then retry.
3. Check http://127.0.0.1:4571/health in a browser — `{"ok":true,...}`
   means the Runner is fine and only the UI tab is lost; open
   http://localhost:1420 manually.
4. Port taken? Something else on 4571/1420 — restart the PC (simplest).

### The AI stopped responding (typed commands still work)
That's the design degrading correctly. Fix the model side:
1. Is Ollama running? Terminal: `ollama list`. If the command is missing,
   reinstall from https://ollama.com/download (free).
2. No chat model? `ollama pull qwen2.5:3b-instruct` (fits 8GB RAM).
3. The HUD's status bar shows the model when detected (may take ~5s).

### A command keeps failing
1. Run it again and read the result card — parsers return exact reasons
   ("unknown chapter…", "bad session…") with valid values listed.
2. `audit` — if RUNS warns, the audit names where to look.
3. Worst case, see a run's steps directly in the DB:
   `bun x drizzle-kit` is NOT needed — just:
   `sqlite3 %USERPROFILE%\.nexus\nexus.db "SELECT intent_key,error FROM runs WHERE status='failed' ORDER BY created_at DESC LIMIT 5;"`
   (or open the file with any SQLite browser).

### A feature disappeared from the deck
Type `modules` → `modules on <name>` (or Settings → Plugins) → restart
Nexus (plugin registration is boot-time). The optional modules —
`academics`, `scholarships`, `agency` — start off on a fresh install.

### Database looks wrong / "missing tables" in audit
1. Restart Nexus — migrations run at every boot and are additive-only.
2. If still failing, your DB file may be corrupt: with Nexus CLOSED, rename
   `%USERPROFILE%\.nexus\nexus.db` to `nexus.db.broken` and restart —
   a fresh DB is created. Restore from your backup if you have one; the
   markdown `vault\` is untouched either way.

### Scholarship sweep finds nothing for days
`scholar feeds` — dead feeds say FAILING. `scholar feed rm <url>` the dead
one, `scholar feed add <url>` a new source (most scholarship sites expose
`/feed/`). Also check `scholar kw` — an over-tight include list mutes
everything.

### Reminders / email drafts error with "permission missing"
Google account was linked before v0.2's write scopes. Settings →
Integrations → disconnect Google → connect again (one browser click).

### Nexus's personality or memory misbehaves
See **docs/BRAIN.md** → "When something's off". Short version: personality
= edit `~/.nexus/brain/identity.md`; wrong memory = `brain forget <file>
confirm`; recall weak = check `ollama list` has `nomic-embed-text`, then
`brain reindex`. The brain's files are ordinary markdown — nothing there
can break the runner.

### Wrong chapter list after a CAIE syllabus revision
Edit `plugins/academics/src/syllabus.ts` — the chapter arrays are plain
data with obvious shape. Change ONLY titles/ids/levels to match the new
official syllabus PDF. Run the three checks.

### Moving to a new PC
1. Install Bun (https://bun.sh) and optionally Ollama.
2. Copy this repo folder AND `C:\Users\<you>\.nexus\` (the data).
3. `bun install` in the repo, then `Start Nexus.cmd`. Done — the DB carries
   every paper, chapter, scholarship, course and client with it.

### Packaging the desktop app (optional, unchanged from v0.1)
See `docs/first-run.md`: install rustup + VS Build Tools,
`bun run build:runner`, copy the exe into
`apps/shell/src-tauri/binaries/nexus-runner-x86_64-pc-windows-msvc.exe`,
then `cargo tauri build`. The dev-mode `Start Nexus.cmd` is fully
supported either way.

## Rules for any AI assistant editing this codebase

1. Read `docs/OPERATING.md` first; the ONE LAW is not negotiable — never
   put an LLM on a write path to `plugin_records`.
2. New tracked data = a new record collection + typed command, copying the
   pattern of `plugins/courses/src/index.ts` (the smallest example).
3. Never edit `migrate.ts` destructively — `CREATE TABLE IF NOT EXISTS`
   and guarded `ALTER TABLE ADD COLUMN` only.
4. Every change ends with: `bun test packages plugins` green,
   `bun run typecheck` silent, `bun run lint` clean, `audit` PASS.
   If you can't get all four, revert your change.
