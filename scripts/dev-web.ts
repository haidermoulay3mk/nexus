/**
 * dev:web — run Nexus without the Tauri shell (Runner + HUD in a browser).
 * Spawns the Runner, reads its auth token, then starts Vite with the
 * connection injected as env vars. Voice STT/TTS need the sidecar binaries;
 * everything else works identically to packaged mode.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const dataDir = process.env.NEXUS_DATA_DIR ?? join(homedir(), ".nexus");
const port = process.env.NEXUS_PORT ?? "4571";

// process.execPath = this Bun binary — immune to PATH shims and to
// space-containing paths that a shell would mangle on Windows.
const bunExe = process.execPath;

console.log("[dev-web] starting runner…");
const runner = spawn(bunExe, ["run", "dev"], {
  cwd: join(repoRoot, "packages", "runner"),
  stdio: "inherit",
  env: { ...process.env, NEXUS_PORT: port },
});

// Wait for the token file, then boot the UI.
const tokenFile = join(dataDir, "runner.token");
const waitForToken = async (): Promise<string> => {
  for (let i = 0; i < 100; i++) {
    if (existsSync(tokenFile)) {
      const t = readFileSync(tokenFile, "utf8").trim();
      if (t) return t;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("runner token never appeared — did the runner boot?");
};

const token = await waitForToken();
console.log("[dev-web] runner token acquired; starting HUD…");
console.log("[dev-web] → open http://localhost:1420 once Vite is ready");

const ui = spawn(bunExe, ["run", "dev"], {
  cwd: join(repoRoot, "apps", "ui"),
  stdio: "inherit",
  env: { ...process.env, VITE_NEXUS_PORT: port, VITE_NEXUS_TOKEN: token },
});

// `bun run dev` starts a child process of its own; on Windows killing the parent
// leaves that child alive (holding port 4571), so kill the whole tree.
const killTree = (child: ChildProcess): void => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
};

const stop = () => {
  killTree(runner);
  killTree(ui);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
ui.on("exit", stop);
runner.on("exit", stop);
