import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ModelTier, type Result, err, ok } from "@nexus/core";
import type { LanguageModelV1 } from "ai";

/**
 * Central model selection, keyed by Model Tier. All LLM access in Nexus
 * flows through this module — local Ollama only, never a cloud API.
 */

export const TIER_MODELS: Record<ModelTier, string> = {
  lite: "llama3.2:3b",
  balanced: "qwen2.5:7b-instruct-q4_K_M",
  max: "qwen2.5:14b-instruct-q4_K_M",
};

export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIMS = 768;

/** If a balanced-tier generation takes longer than this per call, drop a tier. */
const LATENCY_FALLBACK_MS = 90_000;
const FALLBACK_AFTER_STRIKES = 2;

export type OllamaState = "ready" | "missing" | "starting" | "error";

export class OllamaService {
  private provider;
  private strikes = 0;
  private tier: ModelTier;
  private readonly configuredTier: ModelTier;
  state: OllamaState = "starting";
  /** models reported by the local daemon */
  private installed: string[] = [];
  /** installed model adopted when the exact tier model isn't pulled */
  private override: string | null = null;

  constructor(
    private readonly baseUrl: string,
    tier: ModelTier,
  ) {
    this.tier = tier;
    this.configuredTier = tier;
    this.provider = createOpenAICompatible({
      name: "ollama",
      baseURL: `${baseUrl}/v1`,
    });
  }

  get activeTier(): ModelTier {
    return this.tier;
  }

  get activeModel(): string {
    return this.override ?? TIER_MODELS[this.tier];
  }

  chatModel(): LanguageModelV1 {
    return this.provider.chatModel(this.activeModel);
  }

  /**
   * Called by the orchestrator after each model call; two consecutive
   * over-budget calls on `balanced`/`max` drop one tier (7B → 3B).
   */
  reportLatency(ms: number): void {
    if (this.tier === "lite") return;
    if (ms > LATENCY_FALLBACK_MS) {
      this.strikes += 1;
      if (this.strikes >= FALLBACK_AFTER_STRIKES) {
        this.tier = this.tier === "max" ? "balanced" : "lite";
        this.strikes = 0;
        console.warn(`[ollama] latency fallback → tier=${this.tier} (${this.activeModel})`);
      }
    } else {
      this.strikes = 0;
    }
  }

  /** Detect the daemon and which tier models are pulled. */
  async healthcheck(): Promise<Result<{ models: string[] }>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) {
        this.state = "error";
        return err("OLLAMA_HTTP", `Ollama responded ${res.status}`);
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      this.installed = (data.models ?? []).map((m) => m.name);

      const exact = (name: string) =>
        this.installed.includes(name) || this.installed.includes(`${name}:latest`);

      this.override = null;
      if (!exact(TIER_MODELS[this.tier])) {
        // 1) degrade to a lower tier whose exact model IS pulled
        const order: ModelTier[] = ["max", "balanced", "lite"];
        const usable = order
          .slice(order.indexOf(this.configuredTier))
          .find((t) => exact(TIER_MODELS[t]));
        if (usable) {
          this.tier = usable;
        } else {
          // 2) adopt any installed chat model from the tier families —
          //    never force the user into a multi-GB download to boot.
          const families = [
            "qwen2.5:",
            "qwen2:",
            "llama3.2:",
            "llama3.1:",
            "llama3:",
            "mistral:",
            "gemma2:",
          ];
          const adopted = this.installed.find(
            (m) => families.some((f) => m.startsWith(f)) && !m.includes("embed"),
          );
          if (adopted) this.override = adopted;
        }
      }

      if (this.override === null && !this.hasModel(TIER_MODELS[this.tier])) {
        this.state = "missing";
        return err("OLLAMA_NO_MODEL", "Ollama is running but no usable chat model is pulled");
      }
      this.state = "ready";
      return ok({ models: this.installed });
    } catch (e) {
      this.state = "missing";
      return err("OLLAMA_DOWN", "Ollama daemon is not reachable on 127.0.0.1:11434", e);
    }
  }

  hasModel(name: string): boolean {
    const bare = name.split(":")[0] ?? name;
    return this.installed.some((m) => m === name || m.startsWith(`${bare}:`));
  }

  /** Local embeddings via Ollama's native endpoint. */
  async embed(texts: string[]): Promise<Result<Float32Array[]>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return err("EMBED_HTTP", `embed failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { embeddings: number[][] };
      return ok(data.embeddings.map((e) => Float32Array.from(e)));
    } catch (e) {
      return err("EMBED_FAIL", "local embedding failed (is nomic-embed-text pulled?)", e);
    }
  }
}
