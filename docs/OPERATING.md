# OPERATING NEXUS — the owner's manual

Everything below is designed to run **without any capable AI**: on a small
local Ollama model such as `qwen2.5:3b-instruct` or `llama3.2:3b`, or with no
model at all. If you are an AI assistant reading this: follow it literally;
do not improvise. New here? Start with **docs/first-run.md**.

> v0.3 added the **brain**: a persistent identity, always-loaded core
> knowledge, conversations that survive restarts, and file-backed long-term
> memory. Talking to Nexus in the palette is now a real conversation — it
> knows you and it remembers. Full guide: **docs/BRAIN.md**. Key commands:
> `brain`, `brain save … | … | …`, `brain recall …`, `session`.
> Its files live in `~/.nexus/brain/` — edit `identity.md` any time; the
> very next reply follows it.

## THE ONE LAW

> **The database is the source of truth. Code writes it. The model only
> narrates it.**

Every tracking operation is a **typed command** parsed by TypeScript
(`packages/runner/src/commands.ts` routes; each plugin parses). The LLM is
never on the write path. If Ollama is broken, EVERY command below still
works — only free-form chat, AI briefs and email-draft wording stop.

## DAILY USE

1. Double-click **`Start Nexus.cmd`** (full HUD at http://localhost:1420),
   or **`Start Nexus Runner (headless).cmd`** if you just want schedules
   to fire. Run `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`
   once to make the headless Runner start at every login.
2. Press **Ctrl+K** and type commands. Type `help` for the full list.
   First time? `setup` (then `setup name …`, `setup goal …`) — a fresh
   install knows nothing about you until you tell it.
3. Schedules (Runner must be running): morning report 08:00 ·
   **course staleness check 09:00** · **scholarship sweep 08:30** (only when
   the scholarships module is on).

## MODULES

`modules` lists every module and whether it's on. The niche ones start
**off** on a fresh install — `academics` (CAIE A Levels), `scholarships`,
`agency` — turn one on with `modules on <name>` and restart Nexus. The
sections below for those modules apply once they're on.

## COMMAND REFERENCE (all work with zero AI)

### A Levels — CAIE 9702 Physics · 9709 Maths · 9618 Computer Science (`modules on academics`)
| You want to | Type |
|---|---|
| Log a past paper | `paper 9702 s23 22 48/60` |
| …with time + weak chapters | `paper 9702 s23 22 48/60 t:95 weak:2,9` |
| Delete a wrong log | `paper rm 9702 s23 22` |
| See all logged papers | `papers` or `papers 9702` |
| Mark a chapter | `chapter 9702 2 done` (or `doing` / `todo`) |
| Rate a chapter 1–5 | `chapter 9702 2 rate 4` |
| List chapters + strength | `chapter 9702` |
| Full status board | `board` (or the A-LEVEL BOARD button) |
| What to revise next | `revise` |
| Exam countdown / set dates | `exam` · `exam as 2027-05-14` · `exam al 2028-05-12` |

Notation: subjects `9702|phy`, `9709|maths`, `9618|cs`. Sessions `s23`
(May/June 2023), `w22` (Oct/Nov 2022), `m24` (Feb/Mar 2024). Paper `22` =
paper 2 variant 2; `4` = paper 4 any variant. Maths chapters use component
ids (`1.3` = P1 Coordinate geometry, `4.2` = Mechanics kinematics — run
`chapter 9709` to see them all).

**Strength model (mechanical, no AI judgment):** every chapter has a 1–5
rating you set, plus an automatic drift: tagging `weak:` on a paper knocks
that chapter −0.3; a paper scoring above 70% drifts all its started
chapters up slightly, below 70% down. `revise` = the 3 lowest-strength
started chapters + recent papers you haven't logged.

### Scholarships — worldwide, undergraduate, free feeds (`modules on scholarships`)
| You want to | Type |
|---|---|
| See new finds | `scholar` |
| Sweep feeds right now | `scholar sweep` (also auto-runs daily 08:30) |
| Latest tracked | `scholar list 30` |
| Shortlist one | `scholar star <id>` (ids shown in lists) |
| Your shortlist | `scholar starred` |
| Manage sources | `scholar feeds` · `scholar feed add <url>` · `scholar feed rm <url>` |
| Tune the filter | `scholar kw` (view) · `scholar kw include add <word>` |

The filter is keyword rules in code, not AI: must mention a scholarship
word, and postgrad-only items are dropped unless they also mention
undergrad/bachelor. Feeds are plain WordPress RSS — when one dies,
`scholar feeds` shows it FAILING; remove it and add a replacement
(any scholarship site + `/feed/` usually works).

### Courses
`course add Harvard CS50 | edX | https://cs50.harvard.edu` ·
`course progress cs50 45` · `course touch cs50` · `course done cs50` ·
`course drop cs50` · `course list`.
Anything **active and untouched 7 days** gets a directive on the HUD at the
09:00 check (one per course, auto-deduped).

### Agency — freelance pipeline (`modules on agency`)
`agency lead Acme | found on reddit` → `agency won acme` →
`agency project Chatbot v1 | acme | 500` → `agency done chatbot` →
`agency paid acme 250 first half`. Lists: `agency leads|clients|projects|payments`.
Board: `agency` or the AGENCY BOARD button.

### Email & reminders (confirm-gated — Nexus NEVER sends or books alone)
- `email draft prof@uni.edu | Reference request | asking for a letter, deadline Jan 15`
  → saves a **Gmail draft**; you review and press send in Gmail. Uses the
  local model for wording when available, a plain template otherwise.
- `remind Submit UCL application | 2027-01-15 09:00` (also `tomorrow 18:00`,
  `in 3 days`) → creates a **Google Calendar event** so your phone notifies
  you even with Nexus closed.
- Both need Google connected in Settings → Integrations. Accounts linked
  before v0.2 must disconnect + reconnect once to grant the new permissions.

### Verification — run `audit` whenever anything feels off
SYSTEM AUDIT checks the database, plugins, schedules, model and data
counts, and prints **PASS / WARN / FAIL with the exact fix for each line**.
A weak model has no judgment; this replaces it. After ANY change to Nexus:
`bun test packages plugins` (expect 59+ pass), `bun run typecheck`
(expect silence), `bun run lint` (expect no errors), then `audit` in the
HUD (expect PASS).

## THE WEEKLY LOOP (15 minutes, e.g. Sunday)

1. `board` — read your chapter/strength state. **Good output looks like:**
   every chapter you've studied is `done`/`doing` (not `todo`), strengths
   match your gut. If they don't, fix with `chapter … rate …`.
2. `revise` — do what it says this week: weakest chapters, listed papers.
3. Log every paper the moment you finish marking it — the 30-second habit
   the whole system depends on: `paper 9702 w25 21 52/60 weak:7`.
4. `scholar` — star anything worth applying to; `remind` the deadlines.
5. `course list` — real progress numbers, or drop dead courses honestly.
6. `audit` — must say PASS.

## WHICH MODEL RUNS WHAT

| Task | Runs on |
|---|---|
| ALL tracking commands, boards, revise, sweep, audit | **Code only — no model** |
| Free-form ⌘K questions, AM REPORT, INBOX BRIEF, intel | Ollama `qwen2.5:3b-instruct` (fine — output is narration, never data) |
| Email draft wording | Ollama; template fallback if down |
| Changing Nexus's code | You + MAINTENANCE.md. No AI required for the listed recipes; any coding model helps but keep it to the recipes' scope |

## KNOWN FAILURE MODES (and the designed response)

- **You stop logging papers.** The system can't see unlogged work; `revise`
  goes stale silently. Response: log at the marking desk, not "later".
- **A scholarship feed dies.** Sweep reports it, keeps working with the
  rest. Replace it via `scholar feed add`.
- **The 3B model writes a bad morning report.** Cosmetic by design — reports
  read the database, never write it. Ignore or re-run.
- **Windows/OneDrive locks the repo.** Data is NOT in the repo — it lives in
  `~/.nexus` (DB, vault, secrets). The repo is code only; back up `~/.nexus`.
- **CAIE revises a syllabus** (~3-year cycles; next likely 2028+). Chapter
  lists live in `plugins/academics/src/syllabus.ts` — edit the arrays,
  run the three verification commands above.
