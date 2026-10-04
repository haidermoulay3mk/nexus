# Nexus — agent spec

> Single source of truth for what we're building and why. Written from the Tier 0 interview.
> The rest of the build — and any future session — should defer to this file.

## What it is

**Nexus** is the core of a **voice-first AI assistant**: a harness that turns a language model into
something I can talk to out loud, that can *do* things on my behalf through tools, that remembers me
between conversations, and that can reach out to me first instead of only answering when spoken to.

It is **not** a chatbot demo. It is a real, dependable assistant I can keep building on.

## Who it's for

Just me (single user). No multi-user state is needed yet, but the harness shouldn't make it hard to
add later.

## What it should help with first

These three jobs become the first tools and the first test cases:

1. **Reminders & tasks** — capture, recall, and nudge me about things to do.
2. **Draft messages & email** — compose messages/emails for me to review. *(Consequential — gated.)*
3. **Calendar & scheduling** — check my schedule, find times, create events. *(Creating events is gated.)*

## Personality

**Extremely smart and confident, of service, with a bit of sarcasm.** Lead with the answer; keep it
brief (it'll be spoken aloud later). The dry wit is welcome — but never about anything safety-critical
or consequential. Same voice everywhere: greetings, replies, logs.

## Stack

- **Language/runtime:** Python (boring, well-supported; first-class Anthropic / Deepgram / ElevenLabs
  SDKs and easy audio).
- **Model:** latest Claude (`claude-opus-4-8`) via the official Anthropic SDK, kept behind a thin seam
  (`nexus/llm.py`) so the provider can be swapped without touching the rest of the harness.
- **Runs on:** my laptop first. The proactive background loop (heartbeat) is built so it can relocate
  to an always-on host later — a move, not a rewrite.

## How I talk to it

**Text first**, always — the typed interface stays alive forever (it's how every future change gets
debugged). For voice, the default is now **hands-free**: an always-on mic where I just talk, with no
key to hold. Nexus decides when I've finished speaking (local voice-activity detection + a silence
endpoint, since Whisper has no native end-of-turn signal). **Push-to-talk** remains as a fallback
(`[voice] mode = "push_to_talk"`). On open laptop speakers it listens half-duplex — it stops hearing
while it speaks, so it never transcribes its own voice; barge-in is opt-in for headphones. The brain
was built and proven in plain text before any audio existed — voice is a thin layer on a working
agent, never the foundation.

## What it must never do without asking me first

A hard confirmation gate stops these until I explicitly approve, per action (approving one does not
pre-authorize the next):

- **Send a message or email**
- **Spend money**
- **Delete data**
- **Change a setting**

Read-only actions run freely. Anything hard to undo asks first — and that gate covers spoken, typed,
and proactively-initiated actions alike.

## Proactivity

**Yes — but quiet by default.** Nexus earns the right to interrupt me; it doesn't assume it. Most
background checks surface nothing most of the time; noteworthy things accumulate in a calm log, and
only something that genuinely warrants it actually interrupts me. It respects quiet hours, holds
notices for me if I was away (never fire-and-forget), and everything it surfaces is dismissible.

## Build discipline

Build **tier by tier**; each tier runs and is verified on its own before the next begins; never fuse
tiers. One shared agent core, many ways in and out — a typed turn, a spoken turn, and a
heartbeat-initiated turn all flow through the same brain.

1. **The brain** — a text conversation loop.
2. **The hands** — tools the agent can call (a registry it grows forever).
3. **The ears and mouth** — push-to-talk speech in (Deepgram), spoken replies out (ElevenLabs).
4. **The memory** — durable, human-readable facts that survive restarts.
5. **The heartbeat** — a background loop that can reach out first, quietly.
6. **The rails** — the confirmation gate, untrusted-content handling, config, audit log, kill switch.

## The feel

Something that has my back, not a parlor trick. It lives or dies on trust and responsiveness.
