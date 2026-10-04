import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Capability, PluginDto } from "@nexus/core";
import type { DbHandle } from "@nexus/db";
import { intents as intentsTable, plugins as pluginsTable } from "@nexus/db";
import type { NexusPlugin } from "@nexus/plugin-sdk";
import { eq } from "drizzle-orm";
import type { CommandRouter } from "../commands";
import type { Orchestrator } from "../orchestrator";
import type { AuditService } from "../services";
import { type WasmPluginManifest, loadWasmPlugin } from "./wasm";

/**
 * Two-tier plugin system:
 *
 *  1. FIRST-PARTY (native TS) — trusted modules compiled into the Runner.
 *     All core features (metrics, notion, calendar, email) are built this
 *     way, dogfooding the same NexusPlugin interface.
 *
 *  2. THIRD-PARTY (Extism WASM) — sandboxed, capability-gated modules
 *     dropped into <dataDir>/plugins/. Each requires explicit user grants.
 */
export class PluginRegistry {
  private loaded = new Map<string, { plugin: NexusPlugin; kind: "native" | "wasm" }>();

  constructor(
    private readonly handle: DbHandle,
    private readonly orchestrator: Orchestrator,
    private readonly auditSvc: AuditService,
    private readonly router: CommandRouter,
    /** tests turn optional modules on; a real fresh install leaves them off */
    private readonly enableOptional = false,
  ) {}

  /** Register a trusted first-party plugin. Grants = full manifest capabilities. */
  async registerNative(plugin: NexusPlugin): Promise<void> {
    const m = plugin.manifest;
    const existing = this.handle.db
      .select()
      .from(pluginsTable)
      .where(eq(pluginsTable.id, m.id))
      .all()[0];

    const grants: Capability[] = existing
      ? (JSON.parse(existing.grantsJson) as Capability[])
      : m.capabilities; // first-party: auto-granted on first load

    const row = {
      id: m.id,
      name: m.name,
      version: m.version,
      kind: "native" as const,
      // A fresh install starts with niche modules off; the stored choice wins after that.
      enabled: existing?.enabled ?? (!m.optional || this.enableOptional),
      manifestJson: JSON.stringify(m),
      grantsJson: JSON.stringify(grants),
    };
    this.handle.db
      .insert(pluginsTable)
      .values(row)
      .onConflictDoUpdate({ target: pluginsTable.id, set: row })
      .run();

    if (!row.enabled) return;

    await plugin.init?.({
      log: {
        info: (msg) => console.log(`[plugin:${m.id}] ${msg}`),
        warn: (msg) => console.warn(`[plugin:${m.id}] ${msg}`),
        error: (msg) => console.error(`[plugin:${m.id}] ${msg}`),
      },
    });

    this.orchestrator.registerPlugin(m, plugin.intents, plugin.tools, grants);
    // Typed command prefixes are first-party-only: WASM plugins never get them.
    this.router.register(plugin.commands);
    this.persistIntents(plugin, m.id);
    this.loaded.set(m.id, { plugin, kind: "native" });
    this.auditSvc.log("system", "plugin.loaded", m.id, { kind: "native", grants });
  }

  /** Scan <dataDir>/plugins for sandboxed WASM plugins (Extism). */
  async loadWasmPlugins(pluginsDir: string): Promise<void> {
    if (!existsSync(pluginsDir)) return;
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(pluginsDir, entry.name, "nexus-plugin.json");
      const wasmPath = join(pluginsDir, entry.name, "plugin.wasm");
      if (!existsSync(manifestPath) || !existsSync(wasmPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WasmPluginManifest;
        const existing = this.handle.db
          .select()
          .from(pluginsTable)
          .where(eq(pluginsTable.id, manifest.id))
          .all()[0];
        // Third-party plugins get NO grants until the user approves them in Settings.
        const grants: Capability[] = existing
          ? (JSON.parse(existing.grantsJson) as Capability[])
          : [];
        const row = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          kind: "wasm" as const,
          enabled: existing?.enabled ?? false, // disabled until user enables
          manifestJson: JSON.stringify(manifest),
          grantsJson: JSON.stringify(grants),
        };
        this.handle.db
          .insert(pluginsTable)
          .values(row)
          .onConflictDoUpdate({ target: pluginsTable.id, set: row })
          .run();
        if (!row.enabled) {
          this.auditSvc.log("system", "plugin.discovered", manifest.id, {
            kind: "wasm",
            enabled: false,
          });
          continue;
        }
        const plugin = await loadWasmPlugin(wasmPath, manifest);
        if (!plugin.ok) {
          console.warn(
            `[plugins] wasm plugin ${manifest.id} failed to load: ${plugin.error.message}`,
          );
          continue;
        }
        this.orchestrator.registerPlugin(
          plugin.value.manifest,
          plugin.value.intents,
          plugin.value.tools,
          grants,
        );
        this.persistIntents(plugin.value, manifest.id);
        this.loaded.set(manifest.id, { plugin: plugin.value, kind: "wasm" });
        this.auditSvc.log("system", "plugin.loaded", manifest.id, { kind: "wasm", grants });
      } catch (e) {
        console.error(`[plugins] failed to read wasm plugin in ${entry.name}:`, e);
      }
    }
  }

  private persistIntents(plugin: NexusPlugin, pluginId: string): void {
    for (const spec of plugin.intents) {
      const row = {
        key: spec.key,
        label: spec.label,
        agent: spec.agent,
        pluginId,
        scheduleCron: spec.scheduleCron,
        enabled: true,
        requiresIntegration: spec.requiresIntegration,
        description: spec.description,
        hidden: spec.hidden ?? false,
      };
      this.handle.db
        .insert(intentsTable)
        .values(row)
        .onConflictDoUpdate({ target: intentsTable.key, set: row })
        .run();
    }
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.handle.db.update(pluginsTable).set({ enabled }).where(eq(pluginsTable.id, pluginId)).run();
    this.auditSvc.log("user", enabled ? "plugin.enabled" : "plugin.disabled", pluginId);
    // Takes full effect on next Runner start (registration is boot-time).
  }

  grant(pluginId: string, grants: Capability[]): void {
    this.handle.db
      .update(pluginsTable)
      .set({ grantsJson: JSON.stringify(grants) })
      .where(eq(pluginsTable.id, pluginId))
      .run();
    this.auditSvc.log("user", "plugin.granted", pluginId, { grants });
  }

  list(): PluginDto[] {
    return this.handle.db
      .select()
      .from(pluginsTable)
      .all()
      .map((p) => {
        const manifest = JSON.parse(p.manifestJson) as {
          capabilities?: Capability[];
          description?: string;
        };
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          kind: p.kind as "native" | "wasm",
          enabled: p.enabled,
          grants: JSON.parse(p.grantsJson) as Capability[],
          requested: manifest.capabilities ?? [],
          description: manifest.description ?? "",
        };
      });
  }

  /** For the `modules` command: every known plugin with its on/off state. */
  modules(): Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    optional: boolean;
  }> {
    return this.handle.db
      .select()
      .from(pluginsTable)
      .all()
      .map((p) => {
        const manifest = JSON.parse(p.manifestJson) as { description?: string; optional?: boolean };
        return {
          id: p.id,
          name: p.name,
          description: manifest.description ?? "",
          enabled: p.enabled,
          optional: manifest.optional === true,
        };
      });
  }

  scheduledJobs() {
    return [...this.loaded.values()].flatMap((l) => l.plugin.scheduledJobs);
  }
}
