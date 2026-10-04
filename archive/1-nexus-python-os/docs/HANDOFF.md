# Nexus — status & handoff

Snapshot of what's built, what works now, and what still needs your machine
(microphone/speakers) to finish. Written 2026-06-19.

## How you use it

- Launch from the **Start menu** or **Desktop** "Nexus" icon (or pin to taskbar).
- It opens as its **own native app window** (not a browser, not Edge).
- Type to it like a person, or tap the **mic button** (see voice status below).
- The little engine runs silently inside the app — no extra window.

## What works right now (verified)

- **Native desktop app**: packaged `Nexus.exe`, installed to
  `%LOCALAPPDATA%\Programs\Nexus`, listed in Settings > Apps > Installed apps,
  with Start-menu + Desktop shortcuts and a working uninstaller.
- **Study** (Physics/Maths/CS): topics, confidence, past papers, weak/strong,
  progress, recommendations.
- **Tasks & Goals**, **Notes** (remember/recall), **Daily digest**, **Reminders**.
- **Email/Calendar agents** present and route correctly; they need the one-time
  Google sign-in to actually read mail / edit the calendar (not done yet).
- **Natural-language routing**: typed sentences go to the right agent (verified).
- **Jarvis-style dashboard**: dark, glowing, cyan-accented native window.
- **Local model**: `qwen2.5:3b-instruct` via Ollama; answers run on your laptop.
- **77 automated tests** passing, all offline (no Ollama/Google/mic needed).

## Voice — built, but needs your machine to finish

The voice *logic* is complete and tested (wake-word matching, command handling,
clean speech text, British-male voice selection, the speak+route controller).
The parts that need real hardware are **not yet active in the installed app**:

To turn on voice (developer mode, until it's bundled into the app):
```
cd <project folder>
.venv\Scripts\activate
pip install -e .[voice]      # faster-whisper, sounddevice, pyttsx3, keyboard
nexus voice                  # push-to-talk via Ctrl+Space
nexus voice --mode wake      # hands-free wake word ("hey nexus" / "daddy's home")
```
First run downloads a small speech model (~once). The mic button in the app
window currently shows a "voice not installed" message until the voice extra is
bundled into `Nexus.exe` — that bundling + on-device testing is the next step.

### Voice decisions captured (see specs/voice.md)
- Activation: **Ctrl+Space hotkey** AND **wake word** (configurable phrases).
- Replies: **spoken aloud + shown on screen**.
- Persona: **calm British butler (Jarvis)**; picks a British male voice if your
  PC has one (e.g. "Microsoft George").
- Everything local & private — audio never leaves the laptop.

## Next steps (when you're back)

1. **Google email + calendar** — 5-minute one-time sign-in, then "summarize my
   inbox" and calendar editing work.
2. **Voice on the installed app** — bundle the voice extra into `Nexus.exe` and
   test the mic + wake word on your hardware (pick the British voice).
3. Optional: louder "thinking" animation, more agents (German, fitness).

## Repo

Git initialized; history has clean commits per milestone. Tests: `pytest -q`.
Rebuild the app: `pyinstaller packaging\Nexus.spec` then
`powershell -File packaging\install.ps1`.
