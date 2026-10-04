# Nexus Architecture

## Three processes

```
┌──────────────────────────────────────────────────────────────┐
│ TAURI SHELL (Rust) — thin, native, always-on                  │
│ window/tray · global push-to-talk · Stronghold vault ·        │
│ spawns + supervises the Runner (health poll + respawn)        │
└──────────────┬──────────────────────────────┬────────────────┘
               │ injects {port, token}        │ spawns w/ env
               ▼                              ▼
┌───────────────────────────┐   ┌──────────────────────────────┐
│ REACT UI (WebView2)       │◄─►│ BUN RUNNER (sidecar)          │
│ cinematic HUD             │WS │ Hono API + WS bus (127.0.0.1) │
│ R3F nebula · Zustand      │   │ Orchestrator · agents · tools │
│ never writes the DB       │   │ queue · scheduler · memory    │
│ never sees raw secrets    │   │ voice · integrations · plugins│
│                           │   │ SOLE writer of the SQLite DB  │
└───────────────────────────┘   └──────────────────────────────┘
```

- **Shell** (`apps/shell`): Tauri 2. Registers `Ctrl+Shift+Space` push-to-talk, injects `window.__NEXUS__ = {port, token}` into the webview, supervises the Runner with a `/health` poll (3 strikes → respawn with backoff), owns the Stronghold vault and pushes unlocked secrets to the Runner's **in-memory** store over the authed loopback API.
- **Runner** (`packages/runner`): a Bun binary. Everything stateful lives here so scheduled intents run with the window closed.
- **UI** (`apps/ui`): pure renderer over a `/state` snapshot + live WS events.

## Data flow

```
voice/click → INTENT → queue (SQLite, durable) → Orchestrator
  → picks Agent (system prompt + tool allowlist + max steps)
  → Vercel AI SDK multi-step loop ↔ Ollama (127.0.0.1:11434)
  → tools = the ONLY world access (Zod-typed, capability-gated, audited)
  → streams run.token/run.step over WS → AI WIRE typewriter
  → IntentResult → document (vault .md + DB) + result card + wire lines
  → episodic memory entry → optional Piper TTS summary
```

## Event contract

Every WS frame is `{type, ts, payload}` validated by Zod (`packages/core/src/events.ts`):
`system.status · capability.tiers · link.status · run.queued/started/step/token/completed/failed · card.created/updated · cards.cleared · vitals.update · wire.append · document.created · directives.update · voice.* · toast`.
UI→Runner commands: `intent.dispatch · run.cancel · voice.start/stop · settings.update · plugin.toggle · card.move · cards.clear · directive.add/toggle`.

## Adaptive tiers

First boot probes RAM/VRAM (`nvidia-smi` when present) → **Model Tier** (`lite` 3B / `balanced` 7B / `max` 14B) and **Visual Tier** (particle count 1.5k/4.5k/9k, bloom off/on, dpr). Two consecutive slow generations drop one model tier; if the exact tier model isn't pulled, the Runner **adopts any installed compatible chat model** rather than forcing a download.

## Memory (4 layers)

1. **Working** — rolling token-budgeted buffer (`messages`).
2. **Semantic** — `memories` embedded via `nomic-embed-text` into `sqlite-vec` (cosine KNN); pure-JS brute-force fallback when the extension can't load; vectors backfill when embeddings come online.
3. **Structured** — typed facts / prefs / entities.
4. **Episodic** — every run logged (`runs`, `run_steps`) + an `[episode]` memory row; powers `runs.recent` and the DOCUMENTS trail.

## Security

- Runner binds **127.0.0.1 only**; every route except `/health` requires the boot-generated bearer token; CORS restricted to the two known HUD origins.
- Secrets: Stronghold (packaged) / AES-256-GCM local file (dev). Never in the DB, logs, WS frames, or the UI.
- Tools are capability-gated per plugin manifest; every call and permission denial is written to `audit`.
- Third-party plugins run in the **Extism WASM sandbox** with zero grants until the user approves; output is sanitized and they get no host functions in v1.
- No outbound network except explicit user-configured integrations and keyless cached fetches invoked by the user (GH trending, RSS).

## Queue & scheduler

`tasks` is a durable SQLite queue drained with bounded concurrency (default 3); `active` tasks are re-queued on boot (crash recovery). `croner` fires scheduled intents (reference: `AM REPORT` daily 08:00) by enqueuing — durability and concurrency come for free.
