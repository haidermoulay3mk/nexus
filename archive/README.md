# How NEXUS got here

NEXUS is the current version of a personal-assistant project that started as "Jarvis". Every earlier generation is kept
here, untouched apart from removing secrets and personal data, so you can see how it evolved. **None of these are
needed to run NEXUS** — the app lives at the root of this repository. The two web-app generations are described
rather than included: their files shipped with their author's own routine as the default content.

| Folder | What it was | Stack |
|---|---|---|
| [`0-jarvis/`](0-jarvis/) | **Jarvis** — double-clap your desk and it opens your apps, plays a song and greets you; later a two-way voice chat. | Python, sounddevice, faster-whisper |
| [`0b-jarvis-web-apps/`](0b-jarvis-web-apps/) | **Jarvis on the web** (from the old `Jarvis`, `Jarvis-v2` and `jarvis-phone` repos) — a gamified habit-tracker page, then the installable "Personal Jarvis" phone app that grew into `3-nexus-web-app`. *(description only)* | HTML, PWA, Vercel |
| [`1-nexus-python-os/`](1-nexus-python-os/) | **NEXUS v1** — a local-first "personal AI OS": study tracker (A Levels), Gmail, Google Calendar, memory, CLI + web dashboard. | Python, Ollama, SQLite, FastAPI |
| [`2-nexus-voice-core/`](2-nexus-voice-core/) | **NEXUS core** — rebuilt tier by tier as a voice-first assistant: brain → tools → memory → proactive heartbeat → safety rails → voice. | Python, Ollama, Whisper, Windows voice |
| [`3-nexus-web-app/`](3-nexus-web-app/) | **NEXUS web app** — a single-file dashboard (habits, roadmap, trackers) you can install as an app; data stays in your browser. *(description only)* | One HTML file, PWA |
| *(repository root)* | **NEXUS v0.3** — the current version: a cinematic HUD + background Runner with local AI agents, plugins, long-term memory. | Bun, TypeScript, React, Tauri, SQLite |

Each folder has its own README with setup instructions. Secrets (`.env`), databases, virtual environments and build
outputs were never copied; example config files (`.env.example`) show which keys each version expected.
