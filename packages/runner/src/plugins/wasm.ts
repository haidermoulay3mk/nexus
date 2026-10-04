import { type Result, err, ok } from "@nexus/core";
import { AGENT, type Capability } from "@nexus/core";
import type { IntentResult, NexusPlugin } from "@nexus/plugin-sdk";

/**
 * Extism WASM plugin tier — third-party, sandboxed, least-privilege.
 *
 * v1 ABI (intentionally small):
 *   export "describe" () -> JSON { intents: [{ key, label, description }] }
 *   export "run"      (JSON { intentKey, input }) -> JSON IntentResult
 *
 * WASM plugins are pure compute inside the Extism sandbox: no filesystem,
 * no network, no host functions in v1. Their output is materialized by the
 * orchestrator exactly like native plugin output (document/card/wire), so
 * a malicious plugin can at worst produce text. Capability grants gate
 * whether their intents may run at all.
 */

export interface WasmPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: Capability[];
}

interface WasmDescribe {
  intents: Array<{ key: string; label: string; description: string }>;
}

export async function loadWasmPlugin(
  wasmPath: string,
  manifest: WasmPluginManifest,
): Promise<Result<NexusPlugin>> {
  try {
    // Dynamic import keeps the Runner bootable if the Extism runtime is
    // unavailable on this platform (plugins simply don't load).
    const extism = (await import("@extism/extism")) as {
      default?: unknown;
      createPlugin: (
        src: string | { path: string },
        opts: { useWasi: boolean },
      ) => Promise<{
        call(fn: string, input: string): Promise<{ text(): string } | null>;
        close(): Promise<void>;
      }>;
    };
    const instance = await extism.createPlugin({ path: wasmPath }, { useWasi: false });

    const descOut = await instance.call("describe", "");
    if (!descOut) return err("WASM_DESCRIBE", `${manifest.id}: describe() returned nothing`);
    const desc = JSON.parse(descOut.text()) as WasmDescribe;

    const plugin: NexusPlugin = {
      manifest,
      tools: [],
      scheduledJobs: [],
      intents: desc.intents.map((i) => ({
        key: i.key,
        label: i.label,
        agent: AGENT.SYSTEM,
        description: i.description,
        scheduleCron: null,
        requiresIntegration: null,
        handler: async (ctx) => {
          try {
            const out = await instance.call(
              "run",
              JSON.stringify({ intentKey: ctx.intentKey, input: ctx.input }),
            );
            if (!out) return err("WASM_RUN", "plugin returned no output");
            const result = JSON.parse(out.text()) as IntentResult;
            // Sanitize: wasm output is untrusted; only allow the declared shape.
            return ok({
              document: result.document
                ? {
                    kind: String(result.document.kind).slice(0, 32),
                    title: String(result.document.title).slice(0, 120),
                    bodyMd: String(result.document.bodyMd).slice(0, 20_000),
                  }
                : null,
              speak: result.speak ? String(result.speak).slice(0, 300) : null,
              wire: Array.isArray(result.wire)
                ? result.wire.slice(0, 8).map((w) => String(w).slice(0, 200))
                : [],
            });
          } catch (e) {
            return err(
              "WASM_RUN",
              `wasm plugin crashed: ${e instanceof Error ? e.message : String(e)}`,
              e,
            );
          }
        },
      })),
    };
    return ok(plugin);
  } catch (e) {
    return err("WASM_LOAD", `failed to load Extism plugin at ${wasmPath}`, e);
  }
}
