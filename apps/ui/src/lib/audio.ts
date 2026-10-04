/**
 * Push-to-talk recorder: captures mic PCM via WebAudio, downsamples to
 * 16 kHz mono, and encodes a WAV blob for whisper.cpp. Fully local.
 */

export interface Recorder {
  /** live amplitude 0..1 for the waveform, updated every frame */
  readonly level: () => number;
  stop(): Promise<Blob>;
  cancel(): void;
}

const TARGET_RATE = 16_000;

export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const chunks: Float32Array[] = [];
  // ScriptProcessor is deprecated but universally supported and ideal for
  // short push-to-talk captures without shipping a worklet file.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  source.connect(proc);
  proc.connect(ctx.destination);
  proc.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  const levelBuf = new Uint8Array(analyser.frequencyBinCount);
  const level = (): number => {
    analyser.getByteTimeDomainData(levelBuf);
    let max = 0;
    for (const v of levelBuf) max = Math.max(max, Math.abs(v - 128) / 128);
    return max;
  };

  const teardown = () => {
    proc.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };

  return {
    level,
    cancel() {
      teardown();
    },
    async stop(): Promise<Blob> {
      teardown();
      const inputRate = ctx.sampleRate;
      let total = 0;
      for (const c of chunks) total += c.length;
      const joined = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        joined.set(c, off);
        off += c.length;
      }
      const down = downsample(joined, inputRate, TARGET_RATE);
      return encodeWav(down, TARGET_RATE);
    },
  };
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const s of samples) {
    const clamped = Math.max(-1, Math.min(1, s));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
