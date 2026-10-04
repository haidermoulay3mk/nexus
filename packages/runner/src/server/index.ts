import {
  ClientCommand,
  DECK_ORDER,
  type IntentDto,
  type NexusEvent,
  type SystemStatus,
  categorySatisfied,
} from "@nexus/core";
import { integrations as integrationsTable, settings as settingsTable } from "@nexus/db";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { RunnerApp } from "../app";

interface WsData {
  authed: true;
}

/**
 * Loopback-only HTTP + WebSocket server. Every route (except /health)
 * requires the shared auth token, so only the bundled HUD (or the Shell)
 * can connect — nothing else on the machine, and nothing off it.
 */
export function createServer(app: RunnerApp) {
  const hono = new Hono();

  const authed = (req: Request): boolean => {
    const url = new URL(req.url);
    const token =
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("token") ??
      "";
    return token === app.cfg.authToken;
  };

  // CORS: only the bundled HUD origins (Tauri webview + local dev server).
  // The bearer token remains the real gate; this just satisfies preflight.
  hono.use(
    "*",
    cors({
      origin: ["http://localhost:1420", "http://tauri.localhost", "tauri://localhost"],
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST"],
    }),
  );

  hono.get("/health", (c) =>
    c.json({ ok: true, runner: "alive", version: "0.3.0", startedAt: app.startedAt }),
  );

  hono.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (!authed(c.req.raw)) return c.json({ ok: false, error: "unauthorized" }, 401);
    return next();
  });

  /* ---------------- state snapshot for HUD boot ---------------- */

  hono.get("/state", async (c) => {
    const intentRows = app.orchestrator.listIntents();
    const integrationRows = app.handle.db.select().from(integrationsTable).all();
    const connected = new Set(
      integrationRows.filter((i) => i.status === "connected").map((i) => i.provider),
    );
    const intents: IntentDto[] = intentRows.map(({ spec, pluginId }) => ({
      key: spec.key,
      label: spec.label,
      agent: spec.agent,
      pluginId,
      scheduleCron: spec.scheduleCron,
      enabled: true,
      requiresIntegration: spec.requiresIntegration,
      available:
        spec.requiresIntegration === null || categorySatisfied(spec.requiresIntegration, connected),
      description: spec.description,
      hidden: spec.hidden ?? false,
    }));
    // Stable deck ordering
    intents.sort((a, b) => {
      const ai = DECK_ORDER.indexOf(a.key as (typeof DECK_ORDER)[number]);
      const bi = DECK_ORDER.indexOf(b.key as (typeof DECK_ORDER)[number]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    return c.json({
      status: buildStatus(app),
      capability: app.capability,
      intents,
      cards: app.cardsSvc.list(),
      documents: app.documents.list(),
      wire: app.wire.recent(),
      directives: (await app.directivesSvc.list(true)).map((d) => ({ ...d, createdAt: "" })),
      metrics: await app.metricsSvc.all(),
      primary: await app.metricsSvc.primary(),
      plugins: app.plugins.list(),
      integrations: integrationRows.map((i) => ({
        provider: i.provider,
        status: i.status,
        accountLabel: i.accountLabel,
        lastSync: i.lastSync,
      })),
      voice: {
        stt: app.voice.sttAvailable,
        tts: app.voice.ttsAvailable,
        state: app.voice.currentState(),
      },
      schedules: app.scheduler.list(),
    });
  });

  /* ---------------- commands ---------------- */

  hono.post("/cmd", async (c) => {
    const body = await c.req.json();
    const parsed = ClientCommand.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.message }, 400);
    const result = await handleCommand(app, parsed.data);
    return c.json(result);
  });

  /* ---------------- voice ---------------- */

  hono.post("/voice/transcribe", async (c) => {
    const wav = new Uint8Array(await c.req.arrayBuffer());
    if (wav.byteLength < 128) return c.json({ ok: false, error: "empty audio" }, 400);
    const res = await app.voice.transcribe(wav);
    if (!res.ok) return c.json({ ok: false, error: res.error.message }, 503);
    const dispatch = new URL(c.req.url).searchParams.get("dispatch") === "true";
    if (dispatch && res.value.length > 1) {
      app.queue.enqueue("nexus.command", res.value, { priority: 2 });
    }
    return c.json({ ok: true, text: res.value });
  });

  hono.post("/voice/tts", async (c) => {
    const { text } = (await c.req.json()) as { text?: string };
    if (!text) return c.json({ ok: false, error: "no text" }, 400);
    const res = await app.voice.synthesize(text.slice(0, 600));
    if (!res.ok) return c.json({ ok: false, error: res.error.message }, 503);
    return c.body(res.value.buffer as ArrayBuffer, 200, { "content-type": "audio/wav" });
  });

  /* ---------------- documents ---------------- */

  hono.get("/documents/:id", (c) => {
    const rows = app.documents.list(500);
    const doc = rows.find((d) => d.id === c.req.param("id"));
    if (!doc) return c.json({ ok: false, error: "not found" }, 404);
    const full = app.handle.sqlite
      .query("SELECT body_md as bodyMd FROM documents WHERE id = ?")
      .get(doc.id) as { bodyMd: string } | null;
    return c.json({ ok: true, document: { ...doc, bodyMd: full?.bodyMd ?? "" } });
  });

  /* ---------------- integrations (all optional + free) ---------------- */

  hono.post("/integrations/notion/connect", async (c) => {
    const { token } = (await c.req.json()) as { token?: string };
    if (!token) return c.json({ ok: false, error: "token required" }, 400);
    const res = await app.hub.notion.connect(token);
    app.hub.setStatus("notion", res.ok ? "connected" : "error", res.ok ? res.value : null);
    return c.json(
      res.ok ? { ok: true, account: res.value } : { ok: false, error: res.error.message },
    );
  });

  hono.post("/integrations/notion/disconnect", async (c) => {
    await app.hub.notion.disconnect();
    app.hub.setStatus("notion", "disconnected");
    return c.json({ ok: true });
  });

  hono.post("/integrations/google/start", async (c) => {
    const { clientId, clientSecret } = (await c.req.json()) as {
      clientId?: string;
      clientSecret?: string;
    };
    if (!clientId || !clientSecret)
      return c.json({ ok: false, error: "clientId + clientSecret required" }, 400);
    const res = await app.hub.google.start(clientId, clientSecret, (done) => {
      app.hub.setStatus(
        "google",
        done.ok ? "connected" : "error",
        done.ok ? "Google account" : null,
      );
    });
    return c.json(
      res.ok ? { ok: true, authUrl: res.value.authUrl } : { ok: false, error: res.error.message },
    );
  });

  hono.post("/integrations/google/disconnect", async (c) => {
    await app.hub.google.disconnect();
    app.hub.setStatus("google", "disconnected");
    return c.json({ ok: true });
  });

  hono.post("/integrations/imap/connect", async (c) => {
    const { host, port, user, pass } = (await c.req.json()) as Record<string, string>;
    if (!host || !user || !pass)
      return c.json({ ok: false, error: "host, user, pass required" }, 400);
    await app.secrets.set("imap.host", host);
    await app.secrets.set("imap.port", port ?? "993");
    await app.secrets.set("imap.user", user);
    await app.secrets.set("imap.pass", pass);
    app.hub.setStatus("imap", "connected", user);
    return c.json({ ok: true });
  });

  hono.post("/integrations/caldav/connect", async (c) => {
    const { url, user, pass } = (await c.req.json()) as Record<string, string>;
    if (!url || !user || !pass)
      return c.json({ ok: false, error: "url, user, pass required" }, 400);
    await app.secrets.set("caldav.url", url);
    await app.secrets.set("caldav.user", user);
    await app.secrets.set("caldav.pass", pass);
    app.hub.setStatus("caldav", "connected", user);
    return c.json({ ok: true });
  });

  /** Non-secret-ish config values the Settings UI may store in the vault. */
  const CONFIG_SECRET_KEYS = new Set(["notion.parent_page", "config.yt.channels"]);

  hono.post("/config/secret", async (c) => {
    const { key, value } = (await c.req.json()) as { key?: string; value?: string };
    if (!key || !CONFIG_SECRET_KEYS.has(key))
      return c.json({ ok: false, error: "key not allowed" }, 400);
    await app.secrets.set(key, value ?? "");
    return c.json({ ok: true });
  });

  /* ---------------- internal (Shell only) ---------------- */

  hono.post("/internal/secrets", async (c) => {
    // The Tauri Shell pushes Stronghold-unlocked secrets here at boot.
    const entries = (await c.req.json()) as Record<string, string>;
    app.secrets.hydrate(entries);
    return c.json({ ok: true });
  });

  hono.post("/internal/shutdown", (c) => {
    setTimeout(() => process.exit(0), 100);
    return c.json({ ok: true });
  });

  /* ---------------- Bun.serve with WS upgrade ---------------- */

  const sockets = new Set<ServerWebSocket<WsData>>();

  app.bus.subscribe((event: NexusEvent) => {
    const frame = JSON.stringify(event);
    for (const ws of sockets) ws.send(frame);
  });

  const server = Bun.serve<WsData>({
    hostname: app.cfg.host, // 127.0.0.1 — loopback only, never exposed
    port: app.cfg.port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!authed(req)) return new Response("unauthorized", { status: 401 });
        const upgraded = server.upgrade(req, { data: { authed: true as const } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return hono.fetch(req);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        for (const event of app.bus.snapshot()) ws.send(JSON.stringify(event));
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        try {
          const parsed = ClientCommand.safeParse(JSON.parse(String(raw)));
          if (parsed.success) await handleCommand(app, parsed.data);
        } catch (e) {
          console.error("[ws] bad frame:", e);
        }
      },
    },
  });

  return server;
}

/* ------------------------------------------------------------------ */

export function buildStatus(app: RunnerApp): SystemStatus {
  const integrationRows = app.handle.db.select().from(integrationsTable).all();
  const connected = integrationRows.filter((i) => i.status === "connected").length;
  const enabled = integrationRows.length;
  return {
    core: app.orchestrator.activeCount > 0 ? "active" : "idle",
    link:
      enabled === 0
        ? "offline"
        : connected === enabled
          ? "online"
          : connected > 0
            ? "partial"
            : "offline",
    runner: "alive",
    ollama: app.ollama.state,
    model: app.ollama.state === "ready" ? app.ollama.activeModel : null,
    queue: app.queue.status(),
    uptimeSec: Math.round((Date.now() - new Date(app.startedAt).getTime()) / 1000),
  };
}

export async function handleCommand(
  app: RunnerApp,
  cmd: ClientCommand,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  switch (cmd.type) {
    case "intent.dispatch": {
      const intent = app.orchestrator.getIntent(cmd.intentKey);
      if (!intent) return { ok: false, error: `unknown intent ${cmd.intentKey}` };
      const taskId = app.queue.enqueue(cmd.intentKey, cmd.input);
      return { ok: true, data: { taskId } };
    }
    case "run.cancel":
      return { ok: app.orchestrator.cancel(cmd.runId) };
    case "voice.start":
      app.voice.listening(true);
      return { ok: true };
    case "voice.stop":
      app.voice.listening(false);
      return { ok: true };
    case "settings.update": {
      for (const [key, value] of Object.entries(cmd.patch)) {
        const row = { key, valueJson: JSON.stringify(value) };
        app.handle.db
          .insert(settingsTable)
          .values(row)
          .onConflictDoUpdate({ target: settingsTable.key, set: row })
          .run();
      }
      return { ok: true };
    }
    case "plugin.toggle":
      app.plugins.setEnabled(cmd.pluginId, cmd.enabled);
      return { ok: true };
    case "card.move":
      app.cardsSvc.move(cmd.cardId, cmd.x, cmd.y);
      return { ok: true };
    case "cards.clear":
      return { ok: true, data: { cleared: app.cardsSvc.clearAll() } };
    case "directive.toggle":
      await app.directivesSvc.setDone(cmd.directiveId, cmd.done);
      return { ok: true };
    case "directive.add":
      await app.directivesSvc.add(cmd.text);
      return { ok: true };
    default: {
      const exhaustive: never = cmd;
      return { ok: false, error: `unhandled command ${(exhaustive as { type: string }).type}` };
    }
  }
}
