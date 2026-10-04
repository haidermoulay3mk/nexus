# Nexus

A **local-first personal AI operating system**. Nexus runs on your own laptop,
keeps your data on disk, and uses a local model (via [Ollama](https://ollama.com))
to help you manage study, email, calendar, and knowledge — for free, with no paid
APIs required.

> Built for a Windows 11 / Intel i5 / Iris Xe (no dedicated GPU) machine, but runs
> anywhere Python and Ollama do.

---

## What it does today (v1)

- **Study (primary)** — track A-Level **Physics, Mathematics, Computer Science**:
  topics & confidence, past-paper scores, weak/strong topics, progress reports,
  and study recommendations. Works fully offline.
- **Email** — read, summarize, and label your Gmail inbox (needs Google connect).
- **Calendar** — see what's coming up and create/delete Google Calendar events.
- **Knowledge memory** — remember and recall notes (semantic search when a local
  embedding model is available, keyword search otherwise).
- **Daily digest** — a morning briefing combining study focus, today's calendar,
  and your inbox.
- **Two interfaces** — a Rich **CLI** and a local **web dashboard**.

Everything except the Google features runs with **no internet and no model**;
adding Ollama unlocks reasoning, and connecting Google unlocks email/calendar.

---

## Architecture (layers)

```
interface/   CLI (Rich) + dashboard (FastAPI)         <- text-first; voice later
agents/      orchestrator -> Study / Email / Calendar / Assistant (ReAct loop)
tools/       study, memory, and Google tools the agents call
connectors/  Gmail + Calendar (+ centralized Google OAuth)
domains/     study repository (deterministic, fully tested)
memory/      SQLite system-of-record + NumPy vector recall, one service API
models/      tiered Ollama router (fast / balanced / reasoning) + embeddings
kernel/      config, registry, event bus, paths, credentials, types, logging
scheduler/   daily digest + cron-driven scheduled agents
```

**Design principles:** local-first, privacy-focused, modular, extensible (new
agents are added by dropping a YAML file), and dependency-light — generation *and*
embeddings go through Ollama, so there is **no PyTorch/transformers** to fight with.

Add a new agent: drop `config/agents/<name>.yaml` (+ an optional prompt in
`config/prompts/`). No code change needed for a standard agent.

---

## Install

Requires **Python 3.12+** (developed on 3.12; written to run on 3.14 too).

```bash
python -m venv .venv
.venv\Scripts\activate              # Windows
pip install -e .                    # core
pip install -e .[google]            # + Gmail/Calendar
pip install -e .[web]               # + dashboard
pip install -e .[dev]               # + tests
```

### Install Ollama and a model

```bash
# from https://ollama.com, then:
ollama pull qwen2.5:3b-instruct     # balanced (recommended first model)
ollama pull llama3.2:1b             # fast routing
ollama pull nomic-embed-text        # memory embeddings
```

## Quick start

```bash
nexus setup                                   # seed subjects, show next steps
nexus doctor                                  # check Ollama, models, storage
nexus study paper Physics 54 75 --paper "P1 2022"
nexus study weak
nexus study progress
nexus study recommend
nexus ask "what should I revise today?"       # needs Ollama
nexus digest                                  # build today's briefing
nexus dashboard                               # open http://127.0.0.1:8765
nexus backup                                  # snapshot the database
```

### Connect Google (email + calendar)

1. In Google Cloud Console: create a project, enable the **Gmail API** and
   **Google Calendar API**, and create an **OAuth client ID** (type *Desktop app*).
2. Download the client secret JSON to:
   `%LOCALAPPDATA%\Nexus\credentials\google_client_secret.json`
3. Run `nexus connect google` and approve in the browser (one time).

> Email and calendar are the deliberate "cloud when necessary" exception to
> local-first: those features talk to Google over the network, with your consent.
> Everything else (reasoning, study data, memory) stays on your machine.

---

## Where your data lives

`%LOCALAPPDATA%\Nexus\` (override with `NEXUS_HOME`):
`nexus.db` (SQLite), `logs/`, `credentials/` (OAuth tokens are stored in the
Windows Credential Manager via `keyring`, not plaintext), `backups/`.

## Model strategy (CPU, no GPU)

| Tier | Model | Use |
|---|---|---|
| fast | `llama3.2:1b` | routing/classification |
| balanced | `qwen2.5:3b-instruct` | everyday chat (start here) |
| reasoning | `qwen2.5:7b-instruct` | heavy, non-interactive tasks |

Change models in `%LOCALAPPDATA%\Nexus\config\config.toml` or via env vars
(`NEXUS_MODEL_BALANCED`, etc.). Adding a GPU later just means pointing the
reasoning tier at a bigger model — no code changes.

## Python 3.14 note

The dependency set is chosen to be 3.12–3.14 friendly precisely because it avoids
PyTorch/DSPy. If a single dependency lacks a 3.14 wheel at install time, run the
identical code on 3.13. Do not use the experimental free-threaded (no-GIL) build.

## Testing

```bash
pytest -q
```

All core logic is covered offline (no Ollama, no Google needed): kernel, memory,
agents, study, app/CLI, connectors (mocked), scheduler, dashboard, and backups.

## Roadmap

- **v2:** Goals, Tasks/Projects, Health/Fitness, German (spaced repetition),
  University admissions; proactive calendar reminders.
- **v3:** Voice (STT/TTS behind the existing speech interface), optional GPU/cloud
  reasoning tier, richer dashboard, shareable agent packs.
