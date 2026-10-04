import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexusPlugin } from "@nexus/plugin-sdk";
import { type PluginDeps, type RunnerApp, buildApp } from "../../src/app";
import type { RunnerConfig } from "../../src/config";

export interface TestHarness {
  app: RunnerApp;
  cfg: RunnerConfig;
  cleanup(): void;
}

export async function makeTestApp(opts: {
  ollamaUrl: string;
  plugins?: Array<(deps: PluginDeps) => NexusPlugin>;
  /** real first-boot defaults: optional modules start OFF */
  freshInstall?: boolean;
}): Promise<TestHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-test-"));
  const cfg: RunnerConfig = {
    dataDir,
    dbPath: join(dataDir, "test.db"),
    vaultDir: join(dataDir, "vault"),
    host: "127.0.0.1",
    port: 0,
    authToken: "test-token",
    ollamaBaseUrl: opts.ollamaUrl,
    whisperBin: "",
    whisperModel: "",
    piperBin: "",
    piperVoice: "",
    maxConcurrentRuns: 2,
  };
  const app = await buildApp(cfg, {
    nativePlugins: opts.plugins ?? [],
    emitStatus: false,
    // most tests exercise every module; `freshInstall` reproduces a new user's defaults
    enableOptionalModules: !opts.freshInstall,
  });
  const harness: TestHarness = {
    app,
    cfg,
    cleanup() {
      // Shut down whichever app is live — a restart test swaps `harness.app`.
      harness.app.shutdown();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows may briefly hold WAL locks after close — the OS temp
        // cleaner reclaims the dir; not a test failure.
      }
    },
  };
  return harness;
}

/** Poll until a predicate passes or time out. */
export async function until(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition never became true");
}
