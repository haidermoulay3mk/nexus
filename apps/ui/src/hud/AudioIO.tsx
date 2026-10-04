import { useEffect, useRef } from "react";
import { Panel } from "../components/Panel";
import { Waveform } from "../components/Waveform";
import { sendCommand, transcribe } from "../lib/api";
import { type Recorder, startRecording } from "../lib/audio";
import { stopTts } from "../lib/ws";
import { useSystemStore } from "../state/useSystemStore";
import { useVoiceStore } from "../state/useVoiceStore";

/**
 * AUDIO I/O — push-to-talk (hold SPACE) + TTS state + live waveform.
 * SPACE is ignored while typing in inputs; ESC stops TTS playback.
 */
export function AudioIO() {
  const voiceCaps = useSystemStore((s) => s.voice);
  const vState = useVoiceStore((s) => s.state);
  const speaking = useVoiceStore((s) => s.speakingText);
  const transcript = useVoiceStore((s) => s.transcript);
  const holding = useVoiceStore((s) => s.holding);
  const recorder = useRef<Recorder | null>(null);
  const levelRaf = useRef(0);

  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    };

    const begin = async () => {
      if (recorder.current || !voiceCaps.stt) return;
      const store = useVoiceStore.getState();
      try {
        recorder.current = await startRecording();
        store.setHolding(true);
        store.setState("listening");
        void sendCommand({ type: "voice.start" });
        const tick = () => {
          if (!recorder.current) return;
          store.setMicLevel(recorder.current.level());
          levelRaf.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        console.error("[voice] mic unavailable:", err);
        store.setState("error");
      }
    };

    const end = async () => {
      if (!recorder.current) return;
      cancelAnimationFrame(levelRaf.current);
      const rec = recorder.current;
      recorder.current = null;
      const store = useVoiceStore.getState();
      store.setHolding(false);
      store.setMicLevel(0);
      store.setState("transcribing");
      void sendCommand({ type: "voice.stop" });
      try {
        const wav = await rec.stop();
        const res = await transcribe(wav, true);
        store.setTranscript(res.text ?? "");
        store.setState("standby");
      } catch (err) {
        console.error("[voice] transcription failed:", err);
        store.setState("error");
      }
    };

    const down = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        stopTts();
        return;
      }
      if (e.code !== "Space" || e.repeat || isTyping()) return;
      e.preventDefault();
      void begin();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      void end();
    };
    // Global shortcut relayed by the Tauri Shell (Ctrl+Shift+Space).
    const ptt = (e: Event) => {
      const phase = (e as CustomEvent<string>).detail;
      if (phase === "down") void begin();
      else void end();
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("nexus:ptt", ptt);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("nexus:ptt", ptt);
      recorder.current?.cancel();
    };
  }, [voiceCaps.stt]);

  const stateLabel = !voiceCaps.stt
    ? "STT · NOT INSTALLED"
    : vState === "listening"
      ? "LISTENING"
      : vState === "transcribing"
        ? "TRANSCRIBING…"
        : speaking
          ? "SPEAKING"
          : "STANDBY";

  return (
    <Panel
      title="AUDIO I/O"
      active={holding || !!speaking}
      titleRight={
        <span className="hud-label flex items-center gap-1.5" style={{ fontSize: "0.5rem" }}>
          {speaking && (
            <span
              className="speaking-ring inline-block"
              style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-hot)" }}
            />
          )}
          TTS.{voiceCaps.tts ? (speaking ? "ACTIVE" : "STANDBY") : "OFF"}
        </span>
      }
    >
      <div className="flex flex-col items-center gap-1 py-1">
        <Waveform width={230} height={34} />
        <div
          className="hud-label"
          style={{ fontSize: "0.5rem", color: holding ? "var(--accent)" : undefined }}
        >
          {stateLabel}
        </div>
        {transcript && (
          <p
            className="text-center"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.55rem",
              color: "var(--text)",
              maxWidth: 230,
            }}
          >
            “{transcript.length > 90 ? `${transcript.slice(0, 90)}…` : transcript}”
          </p>
        )}
        <div
          className="flex justify-between w-full pt-1 border-t"
          style={{ borderColor: "var(--line-hairline)" }}
        >
          <span className="hud-label" style={{ fontSize: "0.45rem" }}>
            HOLD SPACE TO TALK
          </span>
          <span className="hud-label" style={{ fontSize: "0.45rem" }}>
            ESC TO STOP
          </span>
        </div>
      </div>
    </Panel>
  );
}
