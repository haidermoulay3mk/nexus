import { join } from "node:path";
import { type CapabilityProfile, INTENT } from "@nexus/core";
import { type DbHandle, openDb } from "@nexus/db";
import { capability as capabilityTable, integrations as integrationsTable } from "@nexus/db";
import type { NexusPlugin, OpsSnapshot } from "@nexus/plugin-sdk";
import { desc } from "drizzle-orm";
import { probeCapability } from "./ai/capability";
import { OllamaService } from "./ai/ollama";
import { BrainService, type CapabilitySnapshot } from "./brain";
import { ChatService } from "./brain/chat";
import { createBrainPlugin } from "./brain/plugin";
import { BrainStore } from "./brain/store";
import { EventBus } from "./bus";
import { CommandRouter } from "./commands";
import type { RunnerConfig } from "./config";
import { IntegrationHub } from "./integrations";
import { MemoryService } from "./memory";
import { Orchestrator } from "./orchestrator";
import { createCorePlugin } from "./plugins/corePlugin";
import { PluginRegistry } from "./plugins/loader";
import { TaskQueue } from "./queue";
import { Scheduler } from "./scheduler";
import {
  AuditService,
  CardService,
  DirectiveService,
  DocumentService,
  MetricService,
  NetService,
  RecordsService,
  SecretService,
  WireService,
} from "./services";
import { VoiceService } from "./voice";

export interface RunnerApp {
  cfg: RunnerConfig;
  handle: DbHandle;
  bus: EventBus;
  capability: CapabilityProfile;
  ollama: OllamaService;
  memory: MemoryService;
  documents: DocumentService;
  cardsSvc: CardService;
  metricsSvc: MetricService;
  wire: WireService;
  net: NetService;
  directivesSvc: DirectiveService;
  secrets: SecretService;
  recordsSvc: RecordsService;
  auditSvc: AuditService;
  router: CommandRouter;
  brain: BrainService;
  brainStore: BrainStore;
  chatSvc: ChatService;
  orchestrator: Orchestrator;
  queue: TaskQueue;
  scheduler: Scheduler;
  voice: VoiceService;
  plugins: PluginRegistry;
  hub: IntegrationHub;
  startedAt: string;
  shutdown(): void;
}

/** Trusted deps handed to first-party plugin factories (never to WASM). */
export interface PluginDeps {
  hub: IntegrationHub;
  /** DB maintenance hook for VAULT CLEAN (prune + vacuum) */
  maintenance: () => { prunedTasks: number; prunedRuns: number; prunedWire: number };
  /** deterministic health snapshot for SYSTEM AUDIT */
  introspect: () => OpsSnapshot;
}

export interface BuildOptions {
  /** first-party plugin factories (injected so tests can supply mocks) */
  nativePlugins: Array<(deps: PluginDeps) => NexusPlugin>;
  emitStatus?: boolean;
  /** start optional (niche) modules switched on — tests only; real installs start them off */
  enableOptionalModules?: boolean;
}

export async function buildApp(cfg: RunnerConfig, opts: BuildOptions): Promise<RunnerApp> {
  const handle = openDb(cfg.dbPath);
  const bus = new EventBus();

  /* capability: load persisted profile or probe on first launch */
  const existing = handle.db
    .select()
    .from(capabilityTable)
    .orderBy(desc(capabilityTable.id))
    .limit(1)
    .all()[0];
  let capability: CapabilityProfile;
  if (existing) {
    capability = {
      modelTier: existing.modelTier as CapabilityProfile["modelTier"],
      visualTier: existing.visualTier as CapabilityProfile["visualTier"],
      ramMb: existing.ramMb,
      vramMb: existing.vramMb,
      cpuCores: existing.cpuCores,
      probedAt: existing.probedAt,
    };
  } else {
    capability = await probeCapability();
    handle.db
      .insert(capabilityTable)
      .values({
        modelTier: capability.modelTier,
        visualTier: capability.visualTier,
        ramMb: capability.ramMb,
        vramMb: capability.vramMb,
        cpuCores: capability.cpuCores,
        probedAt: capability.probedAt,
      })
      .run();
  }

  const ollama = new OllamaService(cfg.ollamaBaseUrl, capability.modelTier);
  const memory = new MemoryService(handle, ollama);
  const documents = new DocumentService(handle, bus, cfg.vaultDir);
  const cardsSvc = new CardService(handle, bus);
  const metricsSvc = new MetricService(handle, bus);
  const wire = new WireService(handle, bus);
  const net = new NetService(handle);
  const directivesSvc = new DirectiveService(handle, bus);
  const secrets = new SecretService(cfg.dataDir);
  const recordsSvc = new RecordsService(handle);
  const auditSvc = new AuditService(handle);
  const voice = new VoiceService(cfg, bus);
  const router = new CommandRouter();

  /* The brain: identity/knowledge/memories live in <dataDir>/brain as
   * operator-editable markdown; the capability snapshot is generated lazily
   * from whatever the system actually exposes (never hand-written prose). */
  const brainDir = join(cfg.dataDir, "brain");
  const chatSvc = new ChatService(handle);
  const brainStore = new BrainStore(handle, ollama, brainDir);
  const brain: BrainService = new BrainService(
    brainDir,
    (): CapabilitySnapshot => ({
      model: ollama.state === "ready" ? ollama.activeModel : null,
      intents: orchestrator
        .listIntents()
        .filter((i) => !(i.spec.hidden ?? false))
        .map((i) => ({ label: i.spec.label, description: i.spec.description })),
      commands: router.list().map((c) => ({ prefix: c.prefix, usage: c.usage })),
      integrations: handle.db
        .select()
        .from(integrationsTable)
        .all()
        .map((i) => ({ provider: i.provider, status: i.status })),
      voice: { stt: voice.sttAvailable, tts: voice.ttsAvailable },
    }),
  );

  const orchestrator = new Orchestrator({
    handle,
    bus,
    ollama,
    memory,
    documents,
    cardsSvc,
    metricsSvc,
    wire,
    net,
    directivesSvc,
    secrets,
    recordsSvc,
    auditSvc,
    brain,
    speak: (text) => voice.speak(text),
  });

  const hub = new IntegrationHub(handle, bus, secrets);

  const maintenance = (): { prunedTasks: number; prunedRuns: number; prunedWire: number } => {
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const q = handle.sqlite;
    const prunedTasks = q
      .query("DELETE FROM tasks WHERE status IN ('done','failed') AND created_at < ? RETURNING id")
      .all(cutoff).length;
    const prunedRuns = q
      .query(
        "DELETE FROM runs WHERE status IN ('completed','failed','cancelled') AND created_at < ? RETURNING id",
      )
      .all(cutoff).length;
    const prunedWire = q
      .query("DELETE FROM wire_items WHERE created_at < ? RETURNING id")
      .all(cutoff).length;
    q.exec("VACUUM;");
    return { prunedTasks, prunedRuns, prunedWire };
  };

  const introspect = (): OpsSnapshot => ({
    plugins: plugins.list().map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      enabled: p.enabled,
      kind: p.kind,
    })),
    schedules: app.scheduler ? app.scheduler.list() : [],
    ollama: { state: ollama.state, model: ollama.state === "ready" ? ollama.activeModel : null },
    integrations: handle.db
      .select()
      .from(integrationsTable)
      .all()
      .map((i) => ({ provider: i.provider, status: i.status })),
    dbTables: (
      handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name),
    failedTasks7d:
      (
        handle.sqlite
          .query("SELECT COUNT(*) as n FROM tasks WHERE status='failed' AND created_at > ?")
          .get(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()) as { n: number } | null
      )?.n ?? 0,
    vaultDir: cfg.vaultDir,
    dataDir: cfg.dataDir,
    voice: { stt: voice.sttAvailable, tts: voice.ttsAvailable },
  });

  const pluginDeps: PluginDeps = { hub, maintenance, introspect };
  const plugins = new PluginRegistry(
    handle,
    orchestrator,
    auditSvc,
    router,
    opts.enableOptionalModules ?? false,
  );
  await plugins.registerNative(
    createCorePlugin({
      router,
      chat: chatSvc,
      setup: {
        state: () => brain.setupState(),
        setName: (name) => brain.setOperatorName(name),
        addGoal: (goal) => brain.addGoal(goal),
        dataDir: cfg.dataDir,
      },
      modules: {
        list: () => plugins.modules(),
        setEnabled: (id, enabled) => plugins.setEnabled(id, enabled),
      },
      // The queue is constructed below; commands only fire at runtime, long after boot.
      enqueue: (intentKey, input) => app.queue.enqueue(intentKey, input, { priority: 2 }),
    }),
  );
  await plugins.registerNative(
    createBrainPlugin({
      brain,
      store: brainStore,
      chat: chatSvc,
      commandPrefixes: () => router.list().map((c) => c.prefix),
      enqueue: (intentKey, input) => app.queue.enqueue(intentKey, input, { priority: 0 }),
    }),
  );
  for (const factory of opts.nativePlugins) {
    await plugins.registerNative(factory(pluginDeps));
  }
  await plugins.loadWasmPlugins(join(cfg.dataDir, "plugins"));

  let statusTimer: ReturnType<typeof setInterval> | null = null;
  const app: RunnerApp = {
    cfg,
    handle,
    bus,
    capability,
    ollama,
    memory,
    documents,
    cardsSvc,
    metricsSvc,
    wire,
    net,
    directivesSvc,
    secrets,
    recordsSvc,
    auditSvc,
    router,
    brain,
    brainStore,
    chatSvc,
    orchestrator,
    queue: null as unknown as TaskQueue, // assigned below (queue needs app closure)
    scheduler: null as unknown as Scheduler,
    voice,
    plugins,
    hub,
    startedAt: new Date().toISOString(),
    shutdown() {
      if (statusTimer) clearInterval(statusTimer);
      app.queue.stop();
      app.scheduler.stop();
      handle.close();
    },
  };

  const { buildStatus } = await import("./server");
  const emitStatus = () => bus.emit("system.status", buildStatus(app));

  app.queue = new TaskQueue(handle, bus, orchestrator, cfg.maxConcurrentRuns, emitStatus);
  app.scheduler = new Scheduler(app.queue);

  // Scheduled jobs come from plugin declarations AND intent-level cron fields.
  const jobs = [
    ...plugins.scheduledJobs(),
    ...orchestrator
      .listIntents()
      .filter((i) => i.spec.scheduleCron)
      .map((i) => ({
        id: `intent:${i.spec.key}`,
        cron: i.spec.scheduleCron as string,
        intentKey: i.spec.key,
      })),
  ];
  // De-dup by id
  const seen = new Set<string>();
  const deduped = jobs.filter((j) => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });
  app.scheduler.register(deduped);

  app.queue.start();

  // Brain boot: reconcile the derived memory index with the files on disk,
  // then sweep any conversations that ended while the Runner was off.
  await brainStore.sync();
  for (const id of chatSvc.pendingExtraction()) {
    app.queue.enqueue(INTENT.BRAIN_EXTRACT, id, { priority: 0 });
  }

  if (opts.emitStatus !== false) {
    void ollama.healthcheck().then(() => emitStatus());
    statusTimer = setInterval(async () => {
      // Re-check Ollama occasionally so a late install is picked up live.
      if (ollama.state !== "ready") await ollama.healthcheck();
      emitStatus();
    }, 5_000);
    bus.emit("capability.tiers", capability);
    const integrationRows = handle.db.select().from(integrationsTable).all();
    bus.emit("link.status", {
      integrations: integrationRows.map((i) => ({
        provider: i.provider,
        status: i.status as "disconnected" | "connected" | "error" | "syncing",
        accountLabel: i.accountLabel,
        lastSync: i.lastSync,
      })),
    });
    await directivesSvc.broadcast();
    await metricsSvc.broadcast();
  }

  return app;
}
