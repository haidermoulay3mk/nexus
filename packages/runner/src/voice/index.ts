import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Result, type VoiceState, err, ok } from "@nexus/core";
import type { EventBus } from "../bus";
import type { RunnerConfig } from "../config";

/**
 * Offline voice pipeline.
 *
 *  STT: the HUD records 16kHz mono WAV (push-to-talk) and POSTs it here;
 *       we spawn whisper.cpp (`whisper-cli`) to transcribe. 100% local.
 *  TTS: we spawn Piper to synthesize a WAV which the HUD plays. 100% local.
 *
 * Both binaries are optional — when absent, voice reports a clear
 * "not installed" state and the rest of Nexus works fully.
 */
export class VoiceService {
  private state: VoiceState = "standby";
  private tmpDir: string;

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly bus: EventBus,
  ) {
    this.tmpDir = join(cfg.dataDir, "tmp");
    mkdirSync(this.tmpDir, { recursive: true });
  }

  get sttAvailable(): boolean {
    return !!this.cfg.whisperBin && existsSync(this.cfg.whisperBin) && !!this.cfg.whisperModel;
  }

  get ttsAvailable(): boolean {
    return !!this.cfg.piperBin && existsSync(this.cfg.piperBin) && !!this.cfg.piperVoice;
  }

  private setState(state: VoiceState): void {
    this.state = state;
    this.bus.emit("voice.state", { state });
  }

  currentState(): VoiceState {
    return this.state;
  }

  async transcribe(wav: Uint8Array): Promise<Result<string>> {
    if (!this.sttAvailable) {
      return err(
        "STT_MISSING",
        "whisper.cpp is not installed. Run the first-run setup (free, offline) to enable voice.",
      );
    }
    this.setState("transcribing");
    const wavPath = join(this.tmpDir, `stt-${randomUUID()}.wav`);
    writeFileSync(wavPath, wav);
    try {
      const proc = Bun.spawn(
        [this.cfg.whisperBin, "-m", this.cfg.whisperModel, "-f", wavPath, "-np", "-nt"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      const exit = await proc.exited;
      if (exit !== 0) {
        const errOut = await new Response(proc.stderr).text();
        return err("STT_FAIL", `whisper.cpp exited ${exit}: ${errOut.slice(0, 300)}`);
      }
      const text = out.replace(/\[[^\]]*\]/g, "").trim();
      this.bus.emit("voice.transcript", { text, final: true });
      return ok(text);
    } catch (e) {
      return err("STT_SPAWN", "failed to spawn whisper.cpp", e);
    } finally {
      rmSync(wavPath, { force: true });
      this.setState("standby");
    }
  }

  async synthesize(text: string): Promise<Result<Uint8Array>> {
    if (!this.ttsAvailable) {
      return err(
        "TTS_MISSING",
        "Piper is not installed. Run the first-run setup (free, offline) to enable TTS.",
      );
    }
    const outPath = join(this.tmpDir, `tts-${randomUUID()}.wav`);
    try {
      const proc = Bun.spawn(
        [this.cfg.piperBin, "--model", this.cfg.piperVoice, "--output_file", outPath],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );
      proc.stdin.write(text);
      proc.stdin.end();
      const exit = await proc.exited;
      if (exit !== 0) {
        const errOut = await new Response(proc.stderr).text();
        return err("TTS_FAIL", `piper exited ${exit}: ${errOut.slice(0, 300)}`);
      }
      const bytes = new Uint8Array(await Bun.file(outPath).arrayBuffer());
      return ok(bytes);
    } catch (e) {
      return err("TTS_SPAWN", "failed to spawn piper", e);
    } finally {
      rmSync(outPath, { force: true });
    }
  }

  /** Fire-and-forget speak: notifies the HUD which fetches + plays the audio. */
  speak(text: string): void {
    if (!this.ttsAvailable) return;
    this.bus.emit("voice.speaking", { on: true, text });
  }

  listening(on: boolean): void {
    this.setState(on ? "listening" : "standby");
    this.bus.emit("voice.listening", { on });
  }
}
