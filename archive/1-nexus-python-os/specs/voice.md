# Voice for Nexus

> Interview note: captured from the user's answers (hotkey **and** wake word with
> flexible phrases; reply by speaking out loud **and** showing text; calm British
> butler / Jarvis persona). The user then went offline before final scope
> confirmation, so the remaining choices below use sensible local-first defaults
> and are called out as **[assumption]**. They can be revised without changing the
> architecture.

## Objective

Let the user talk to Nexus and have it talk back, like Jarvis from Iron Man.
The user speaks (triggered by a keyboard shortcut or a spoken wake word); Nexus
transcribes the speech, routes it through the existing agent system, then both
**speaks the answer aloud** (calm British butler voice) and **shows it on screen**.
Everything runs locally and free — audio never leaves the laptop — consistent with
Nexus's local-first, private design. Voice is an added module behind a stable
interface, not a rewrite of the existing app.

## Requirements

1. **Two activation methods, both available:**
   1.1. **Global hotkey** — a configurable shortcut (default **Ctrl+Space**) that
        works even when the Nexus window is not focused. Press-and-hold or
        press-to-toggle records until the user stops, then processes.
   1.2. **Wake word** — a background listener that activates when it hears any of
        a **configurable list of wake phrases** (defaults: "hey nexus",
        "daddy's home"). Matching is case-insensitive and tolerant of small
        transcription errors. After the wake phrase, the rest of the utterance is
        treated as the command; if nothing follows, Nexus listens for a follow-up.
2. **Speech-to-text (STT), local & free:** transcribe captured microphone audio on
   CPU. **[assumption]** Use `faster-whisper` with a small/base model and int8
   quantization (good accuracy, runs without a GPU). Model downloads once on first
   use.
3. **Command handling:** strip any wake phrase from the transcript and send the
   remaining text to the existing orchestrator (`NexusApp.ask`), so voice reaches
   the same Study / Email / Calendar / Productivity / Assistant agents as typing.
4. **Reply by voice + text:** every spoken request produces (a) the answer spoken
   aloud via TTS, and (b) the same answer shown in the Nexus window.
5. **Text-to-speech (TTS), local & free, British butler voice:** **[assumption]**
   prefer a natural local voice (Piper `en_GB` model); fall back to the Windows
   built-in SAPI5 voices, choosing a British male voice (e.g. "Microsoft George")
   when present, otherwise the best available English voice. Calm, measured
   delivery.
6. **Butler persona:** spoken interactions use a concise, formal, lightly witty
   tone (Jarvis-like). Implemented as an optional system-prompt overlay on the
   assistant, and configurable. **[assumption]** Persona text is on by default for
   voice and does not alter the typed-text experience unless enabled there.
7. **In-app controls & visible state:** the Nexus window has a **microphone
   button** to start/stop listening, and a clear visual indicator of the current
   state: idle, listening, thinking, speaking. A visible control to **stop talking**
   (barge-in) and to **fully disable the mic**.
8. **Privacy & safety:** all audio is captured and processed locally; no audio or
   transcript is sent to any cloud service. The microphone is only active during
   hotkey capture or when the wake-word listener is explicitly enabled. The UI
   always shows when the mic is live, and provides a one-click mute/off.
9. **Configuration:** wake phrases, hotkey, selected voice, speech rate, and
   whether the wake-word listener is enabled are all configurable (config file +
   sensible defaults). Wake-word listening is **[assumption] off by default**
   (privacy first); hotkey works without enabling it.
10. **Graceful degradation:** if audio dependencies or hardware (microphone,
    speakers, voices, STT model) are missing, Nexus still runs fully as a
    text app and clearly tells the user what to install/enable to get voice —
    it never crashes because voice is unavailable.

## Constraints

- **Platform/hardware:** Windows 11, Intel i5, Intel Iris Xe, **no dedicated GPU**.
  STT/TTS must be usable on CPU. Expect noticeable (not instant) latency for STT on
  CPU; keep models small enough to be practical.
- **Local-first & free:** no paid APIs, no cloud STT/TTS, no account required.
- **Python 3.12** (the installed runtime); written to also run on 3.14. Audio deps
  must have Windows wheels for this Python; if a dependency lacks a wheel, document
  it and choose an alternative rather than silently dropping the requirement.
- **Build on the existing system:** reuse `NexusApp`/orchestrator/agents, the
  FastAPI dashboard, and the packaged desktop app. Voice lives in a `speech` module
  behind a stable interface so it can be added/removed without touching the core.
- **Heavy audio dependencies are an optional extra** (`pip install -e .[voice]`),
  not part of the default install, so the base app and its tests stay lightweight.
- **Packaging:** voice should be compatible with the PyInstaller build, or the
  build must clearly document that the voice extra is required for spoken features.

## Edge Cases

1. **No microphone / no audio device:** detect at startup; disable voice input,
   show a clear message, keep text working.
2. **Empty or unintelligible audio:** if STT returns nothing/low confidence, do not
   call an agent; respond (text + optional short voice) asking the user to repeat.
3. **Wake-word false positives:** require a reasonably close match and ignore
   ambient speech that doesn't match a configured phrase; provide an easy off
   switch. Avoid acting on a bare wake word with no command (prompt for a follow-up
   instead).
4. **Long responses:** chunk TTS so speech starts promptly; allow the user to stop
   speech mid-sentence (barge-in) via the stop control or a new activation.
5. **Hotkey conflicts:** if the default hotkey is taken by another app, allow
   reconfiguration; failure to register the hotkey must not crash the app.
6. **No suitable TTS voice installed:** fall back to any available English voice; if
   none, show text only and tell the user how to add a voice.
7. **First-run STT model download:** the model download may be large/slow; show
   progress/status and don't block the rest of the app.
8. **Ollama offline:** voice path must reuse the existing graceful message ("the
   engine isn't running") — spoken and shown — instead of failing.
9. **Rapid re-activation / overlapping requests:** ignore or queue a new activation
   while one is being processed; never run two transcriptions over each other.
10. **Long CPU latency:** show a "thinking/transcribing" state so the user knows it's
    working; consider a small/faster model by default with an option to upgrade.
11. **Privacy expectation:** if wake-word listening is enabled, the always-on mic
    state must be unmistakably visible, and disabling it must be immediate.

## Definition of Done

**Automatically verifiable (no microphone needed):**
1. A `speech` module exists with clean, injectable interfaces for STT, TTS, wake-word
   detection, and a voice controller; importing it never requires audio hardware.
2. Wake-phrase detection correctly matches configured phrases (case-insensitive,
   minor-typo tolerant), extracts the trailing command, and rejects non-matches —
   covered by unit tests.
3. The voice controller, given a fake STT (returns a transcript) and fake TTS
   (records spoken text), routes the command through `NexusApp.ask` and "speaks"
   plus returns the answer — covered by unit tests.
4. TTS text preparation strips markdown/symbols so spoken output is clean — tested.
5. Butler-voice selection picks a British male voice from a provided voice list, with
   documented fallbacks — tested with a fake voice list.
6. With audio dependencies absent, the app and full test suite still pass, and a
   `nexus voice` command prints a clear "install the voice extra" message instead of
   crashing.
7. Config supports wake phrases, hotkey, voice, rate, and wake-word enable flag, with
   defaults; covered by a config test.
8. The dashboard exposes a microphone control and the four visual states in the UI
   markup (idle/listening/thinking/speaking), verified by a rendering test.

**Requires the user's machine to verify (hardware/audio):**
9. Pressing the hotkey records speech, and Nexus speaks + shows a correct answer.
10. Saying a wake phrase (when enabled) triggers listening and a spoken+shown answer.
11. The spoken voice is a calm British male voice when one is available.
12. The mic-on indicator is clearly visible, and mute/stop work immediately.
