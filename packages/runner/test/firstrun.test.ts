import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTENT } from "@nexus/core";
import { createAcademicsPlugin } from "@nexus/plugin-academics";
import { createAgencyPlugin } from "@nexus/plugin-agency";
import { createCoursesPlugin } from "@nexus/plugin-courses";
import { createOpsPlugin } from "@nexus/plugin-ops";
import { createScholarshipsPlugin } from "@nexus/plugin-scholarships";
import type { PluginDeps } from "../src/app";
import { buildApp } from "../src/app";
import { type MockOllama, startMockOllama } from "./helpers/mockOllama";
import { type TestHarness, makeTestApp } from "./helpers/testApp";

/**
 * A brand-new user on the real defaults: Nexus knows nobody, niche modules
 * are off, and `setup` / `modules` (pure code, no model) make it theirs.
 */

const PLUGINS = [
  () => createAcademicsPlugin(),
  () => createScholarshipsPlugin(),
  () => createCoursesPlugin(),
  () => createAgencyPlugin(),
  (deps: PluginDeps) => createOpsPlugin({ introspect: deps.introspect }),
];

let ollama: MockOllama;
let h: TestHarness;

const run = async (input: string): Promise<string> => {
  const res = await h.app.orchestrator.execute(INTENT.COMMAND, input);
  expect(res.ok).toBe(true);
  const [doc] = await h.app.documents.recent(1);
  return doc?.bodyMd ?? "";
};

beforeAll(async () => {
  ollama = startMockOllama("unused — setup and modules never call the model");
  h = await makeTestApp({ ollamaUrl: ollama.url, plugins: PLUGINS, freshInstall: true });
  await h.app.ollama.healthcheck();
});

afterAll(() => {
  h.cleanup();
  ollama.stop();
});

describe("fresh install", () => {
  test("optional modules start off; everyday ones start on", () => {
    const state = Object.fromEntries(h.app.plugins.modules().map((m) => [m.id, m.enabled]));
    expect(state["nexus.academics"]).toBe(false);
    expect(state["nexus.scholarships"]).toBe(false);
    expect(state["nexus.agency"]).toBe(false);
    expect(state["nexus.courses"]).toBe(true);
    expect(h.app.router.list().map((c) => c.prefix)).not.toContain("paper");
  });

  test("the health check passes with optional modules off", async () => {
    const res = await h.app.orchestrator.execute(INTENT.SYS_AUDIT, null);
    expect(res.ok).toBe(true);
    const audit = (await h.app.documents.recent(3)).find((d) => d.title.startsWith("System Audit"));
    expect(audit?.title).toContain("(PASS)");
    expect(audit?.bodyMd).not.toContain("not loaded/enabled");
  });

  test("setup lists what's missing, and help lists setup", async () => {
    const body = await run("setup");
    expect(body).toContain("`setup name <first name>`");
    expect(body).toContain("`setup goal <one line>`");
    expect(body).toContain("`academics` — off");
    expect(body).toContain(h.cfg.dataDir);
    expect(await run("help")).toContain("`setup`");
  });

  test("setup name / goal fill in the user's own brain files", async () => {
    expect(await run("setup name Sam")).toContain("Name set to **Sam**");
    expect(await run("setup name 1234")).toContain("usage");
    expect(await run("setup goal Ship my first app by June")).toContain("Goal **1** added");
    expect(await run("setup")).toContain("**Sam**");
    const user = readFileSync(join(h.cfg.dataDir, "brain", "knowledge", "user.md"), "utf8");
    expect(user).toContain("- Name: Sam");
  });

  test("modules on/off: core can't be switched off; a module turned on loads after restart", async () => {
    expect(await run("modules off core")).toContain("can't be turned off");
    expect(await run("modules on nonsense")).toContain("No module called");
    expect(await run("modules on academics")).toContain("**ON** after Nexus restarts");

    h.app.shutdown();
    const app2 = await buildApp(h.cfg, { nativePlugins: PLUGINS, emitStatus: false });
    (h as { app: typeof app2 }).app = app2; // the harness shuts the live app down
    await app2.ollama.healthcheck();
    expect(app2.router.list().map((c) => c.prefix)).toContain("paper");
    // direct execute (not via the queue) so nothing is still running at shutdown
    const res = await app2.orchestrator.execute(INTENT.ACADEMICS_CMD, "exam");
    expect(res.ok).toBe(true);
    const [doc] = await app2.documents.recent(1);
    expect(doc?.bodyMd).toContain("AS date not set");
  });
});
