# Nexus

The core of a **voice-first AI assistant**, built tier by tier. See [`AGENT.md`](AGENT.md) for what
it is and why. The discipline: the brain works in plain text before any audio exists, and each tier
runs and is verified on its own before the next begins.

## Status

| Tier | Layer | State |
|---|---|---|
| 1 | **The brain** — a text conversation loop | ✅ built |
| 2 | **The hands** — tools the agent can call (reminders) | ✅ built |
| 4 | **The memory** — durable facts across restarts | ✅ built |
| 5 | **The heartbeat** — proactive background loop + inbox | ✅ built |
| 6 | **The rails** — confirmation gate, config, audit, kill switch | ✅ built |
| 3 | **The ears and mouth** — push-to-talk voice | ✅ built |

All six tiers built and verified, **free and local** end to end (Ollama brain, Whisper ears,
Windows-voice mouth). Built in the order 1 → 2 → 4 → 5 → 6 → 3 (voice last, by choice).

## The brain

Nexus runs on a **free, local model** by default — [Ollama](https://ollama.com) with
`qwen2.5:3b-instruct`. No API key, no cost, nothing leaves your laptop. The brain lives behind a
seam ([nexus/llm.py](nexus/llm.py)), so switching to Claude later is just a config edit
(`[model] provider = "anthropic"` + a key in `.env`) — no other code changes.

Prerequisite for the default setup: the Ollama app installed and running, with a model pulled
(`ollama pull qwen2.5:3b-instruct`). `ollama list` shows what you have.

## Setup

Requires **Python 3.11+** (for the stdlib `tomllib` config reader).

```powershell
# from the project root (this folder)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

No `.env` needed for the default local brain. (Only fill `.env` if you switch to the Anthropic backend.)

## Run

```powershell
python -m nexus              # the unified window: type OR hold Right-Ctrl to talk
python -m nexus --text       # typed only (no voice) — for debugging
python -m nexus --heartbeat  # just the proactive loop (for an always-on host)
```

One window, one prompt: **type a line and press Enter, or hold Right-Ctrl and speak.** Replies are
printed and spoken aloud (`/mute` to silence). It remembers you across restarts, manages reminders,
holds proactive notices in an inbox, and stops for your explicit yes before any consequential action.
`/help` lists commands: `/inbox`, `/dismiss`, `/mute`, `/speak`, `/pause` (kill switch), `/resume`,
`/usage`, `/exit`. The double-click launcher `Nexus.bat` opens this window.

### Voice (free + local)

Push-to-talk: hold a key, speak, release. Hearing is [Whisper](https://github.com/openai/whisper)
running locally (faster-whisper); speaking uses your built-in Windows voice (pyttsx3). No keys, no
cost, offline. Both sit behind seams ([nexus/ears.py](nexus/ears.py), [nexus/mouth.py](nexus/mouth.py)),
so switching to Deepgram / ElevenLabs later is a `[voice]` config edit plus keys in `.env` — no code
changes. The first voice run downloads the ~75 MB Whisper model once.

## Verify a tier

```powershell
.\.venv\Scripts\python.exe tests\smoke.py    # Tier 1 checks, incl. a real local conversation
```

## Layout

```
config.toml      all tunables (model, effort, …) — edit, restart, behavior changes
.env             secrets (git-ignored); copy from .env.example
nexus/
  config.py      reads config.toml + .env
  llm.py         the provider seam — the ONLY module that imports the Anthropic SDK
  prompts.py     system-prompt assembly (name, personality, purpose)
  agent.py       the brain: Conversation.respond() — the one entry point every turn flows through
  __main__.py    CLI entry point
```
