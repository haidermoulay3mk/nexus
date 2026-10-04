import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RunnerConfig {
  /** all Nexus state lives under this directory */
  dataDir: string;
  dbPath: string;
  /** markdown vault for generated documents */
  vaultDir: string;
  host: string;
  port: number;
  /** shared secret for the WS/HTTP handshake — only the bundled UI knows it */
  authToken: string;
  ollamaBaseUrl: string;
  /** absolute paths to voice sidecar binaries (empty string = not installed) */
  whisperBin: string;
  whisperModel: string;
  piperBin: string;
  piperVoice: string;
  maxConcurrentRuns: number;
}

/**
 * Config comes from env (set by the Tauri shell when it spawns the sidecar)
 * with local-dev fallbacks. The auth token is generated once per data dir
 * and persisted so the dev-mode UI can read it; in packaged mode the shell
 * passes it to the UI over Tauri IPC instead.
 */
export function loadConfig(): RunnerConfig {
  const dataDir = process.env.NEXUS_DATA_DIR ?? join(homedir(), ".nexus");
  mkdirSync(dataDir, { recursive: true });

  const tokenFile = join(dataDir, "runner.token");
  let authToken = process.env.NEXUS_AUTH_TOKEN ?? "";
  if (!authToken) {
    if (existsSync(tokenFile)) {
      authToken = readFileSync(tokenFile, "utf8").trim();
    }
    if (!authToken) {
      authToken = randomBytes(24).toString("hex");
    }
  }
  // Always persist so dev tooling can connect; file lives in the user-only data dir.
  writeFileSync(tokenFile, authToken, "utf8");

  const vaultDir = join(dataDir, "vault");
  mkdirSync(vaultDir, { recursive: true });

  // Dev-mode voice auto-detect: in packaged mode the Shell passes these
  // paths via env; in `dev:web` we look in the repo's binaries folder so
  // dropped-in whisper/piper files just work.
  const devBinDir = resolve(import.meta.dir, "../../../apps/shell/src-tauri/binaries");
  const devBin = (file: string): string => {
    const p = join(devBinDir, file);
    return existsSync(p) ? p : "";
  };

  return {
    dataDir,
    dbPath: process.env.NEXUS_DB_PATH ?? join(dataDir, "nexus.db"),
    vaultDir,
    host: "127.0.0.1",
    port: Number(process.env.NEXUS_PORT ?? 4571),
    authToken,
    ollamaBaseUrl: process.env.NEXUS_OLLAMA_URL ?? "http://127.0.0.1:11434",
    whisperBin: process.env.NEXUS_WHISPER_BIN ?? devBin("whisper-cli.exe"),
    whisperModel: process.env.NEXUS_WHISPER_MODEL ?? devBin("ggml-base.en.bin"),
    piperBin: process.env.NEXUS_PIPER_BIN ?? devBin("piper.exe"),
    piperVoice: process.env.NEXUS_PIPER_VOICE ?? devBin("en_US-lessac-medium.onnx"),
    maxConcurrentRuns: Number(process.env.NEXUS_MAX_CONCURRENT ?? 3),
  };
}
