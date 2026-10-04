import { randomUUID } from "node:crypto";
import {
  type AgentName,
  type Capability,
  type Result,
  type RunSummary,
  err,
  ok,
} from "@nexus/core";
import type { DbHandle } from "@nexus/db";
import { runSteps, runs } from "@nexus/db";
import type {
  AgentRunRequest,
  AgentRunResult,
  IntentResult,
  IntentSpec,
  NexusPluginManifest,
  RunContext,
  ToolSpec,
} from "@nexus/plugin-sdk";
import { type CoreTool, streamText, tool } from "ai";
import { eq } from "drizzle-orm";
import type { OllamaService } from "../ai/ollama";
import type { BrainService } from "../brain";
import type { EventBus } from "../bus";
import type { MemoryService } from "../memory";
import type {
  AuditService,
  CardService,
  DirectiveService,
  DocumentService,
  MetricService,
  NetService,
  RecordsService,
  SecretService,
  WireService,
} from "../services";
import { AGENTS } from "./agents";
import { CORE_TOOLS } from "./tools";

interface RegisteredIntent {
  spec: IntentSpec;
  pluginId: string;
  grants: Set<Capability>;
}

interface RegisteredTool {
  spec: ToolSpec;
  pluginId: string;
}

export interface OrchestratorDeps {
  handle: DbHandle;
  bus: EventBus;
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
  /** identity + core knowledge + capabilities → two-block system prompt */
  brain: BrainService;
  /** hook into the voice service; null in tests */
  speak: ((text: string) => void) | null;
}

const now = () => new Date().toISOString();

export class Orchestrator {
  private intents = new Map<string, RegisteredIntent>();
  private tools = new Map<string, RegisteredTool>();
  private aborters = new Map<string, AbortController>();
  activeCount = 0;

  constructor(private readonly d: OrchestratorDeps) {
    // Core tools belong to the pseudo-plugin "core" with full core grants.
    for (const t of CORE_TOOLS) this.tools.set(t.name, { spec: t, pluginId: "core" });
  }

  registerPlugin(
    manifest: NexusPluginManifest,
    intents: IntentSpec[],
    tools: ToolSpec[],
    grants: Capability[],
  ): void {
    const grantSet = new Set(grants);
    for (const spec of intents) {
      this.intents.set(spec.key, { spec, pluginId: manifest.id, grants: grantSet });
    }
    for (const spec of tools) {
      this.tools.set(spec.name, { spec, pluginId: manifest.id });
    }
  }

  listIntents(): RegisteredIntent[] {
    return [...this.intents.values()];
  }

  getIntent(key: string): RegisteredIntent | undefined {
    return this.intents.get(key);
  }

  cancel(runId: string): boolean {
    const ab = this.aborters.get(runId);
    if (!ab) return false;
    ab.abort();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Run execution                                                       */
  /* ------------------------------------------------------------------ */

  async execute(intentKey: string, input: string | null): Promise<Result<RunSummary>> {
    const reg = this.intents.get(intentKey);
    if (!reg) return err("INTENT_UNKNOWN", `no intent registered for "${intentKey}"`);

    const runId = randomUUID();
    const abort = new AbortController();
    this.aborters.set(runId, abort);

    const base: RunSummary = {
      id: runId,
      intentKey,
      agent: reg.spec.agent,
      status: "active",
      startedAt: now(),
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      error: null,
    };

    this.d.handle.db
      .insert(runs)
      .values({
        id: runId,
        intentKey,
        agent: reg.spec.agent,
        status: "active",
        inputJson: JSON.stringify(input),
        startedAt: base.startedAt,
        createdAt: now(),
      })
      .run();

    this.activeCount += 1;
    this.d.bus.emit("run.started", base);
    this.d.auditSvc.log(reg.pluginId, "intent.execute", intentKey, { runId });

    let stepIdx = 0;
    const recordStep = (
      kind: "model" | "tool" | "note",
      name: string,
      detail: string,
      ms: number | null,
    ) => {
      this.d.handle.db
        .insert(runSteps)
        .values({
          id: randomUUID(),
          runId,
          idx: stepIdx,
          kind,
          name,
          ioJson: JSON.stringify({ detail }),
          ms,
        })
        .run();
      this.d.bus.emit("run.step", { runId, idx: stepIdx, kind, name, detail, ms });
      stepIdx += 1;
    };

    const ctx = this.buildContext(runId, reg, input, abort.signal, recordStep, base);

    try {
      const result = await reg.spec.handler(ctx);
      if (!result.ok) {
        return this.finishRun(base, "failed", result.error.message);
      }
      await this.materialize(runId, reg, result.value);
      return this.finishRun(base, "completed", null);
    } catch (e) {
      const aborted = abort.signal.aborted;
      return this.finishRun(
        base,
        aborted ? "cancelled" : "failed",
        aborted ? "cancelled by user" : e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.aborters.delete(runId);
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  private async materialize(
    runId: string,
    reg: RegisteredIntent,
    result: IntentResult,
  ): Promise<void> {
    let documentId: string | null = null;
    if (result.document) {
      const doc = await this.d.documents.write(
        result.document.kind,
        result.document.title,
        result.document.bodyMd,
        runId,
      );
      documentId = doc.id;
      this.d.cardsSvc.create(
        documentId,
        result.document.title,
        result.document.kind,
        result.document.bodyMd,
      );
    }
    for (const line of result.wire) {
      await this.d.wire.append(reg.spec.key, line);
    }
    if (result.speak && this.d.speak) this.d.speak(result.speak);
    // Episodic memory entry
    await this.d.memory.write(
      "note",
      `[episode] ${reg.spec.label}: ${result.document?.title ?? "completed"} (${now().slice(0, 16)})`,
      `run:${runId}`,
    );
  }

  private finishRun(
    base: RunSummary,
    status: "completed" | "failed" | "cancelled",
    error: string | null,
  ): Result<RunSummary> {
    const summary: RunSummary = { ...base, status, endedAt: now(), error };
    this.d.handle.db
      .update(runs)
      .set({
        status,
        endedAt: summary.endedAt,
        error,
        tokensIn: base.tokensIn,
        tokensOut: base.tokensOut,
      })
      .where(eq(runs.id, base.id))
      .run();
    this.d.bus.emit(status === "completed" ? "run.completed" : "run.failed", summary);
    if (status === "completed") return ok(summary);
    return err("RUN_FAILED", error ?? "run failed");
  }

  /* ------------------------------------------------------------------ */
  /* Context + capability gating                                         */
  /* ------------------------------------------------------------------ */

  private requireGrant(reg: RegisteredIntent, cap: Capability, what: string): void {
    if (!reg.grants.has(cap)) {
      this.d.auditSvc.log(reg.pluginId, "permission.denied", what, { capability: cap });
      throw new Error(`plugin "${reg.pluginId}" lacks capability "${cap}" required by ${what}`);
    }
  }

  private buildContext(
    runId: string,
    reg: RegisteredIntent,
    input: string | null,
    signal: AbortSignal,
    recordStep: (
      kind: "model" | "tool" | "note",
      name: string,
      detail: string,
      ms: number | null,
    ) => void,
    counters: RunSummary,
  ): RunContext {
    const guard = <T extends object>(api: T, cap: Capability): T =>
      new Proxy(api, {
        get: (target, prop, recv) => {
          const v = Reflect.get(target, prop, recv);
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            this.requireGrant(reg, cap, `${cap}:${String(prop)}`);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });

    const ctx: RunContext = {
      runId,
      intentKey: reg.spec.key,
      input,
      offline: this.d.net.lastKnownOffline,
      memory: guard(this.d.memory, "memory.read"),
      documents: guard(this.d.documents, "fs.documents"),
      metrics: guard(this.d.metricsSvc, "metrics.read"),
      llm: {
        complete: async (prompt, opts) => {
          this.requireGrant(reg, "llm.chat", "llm.complete");
          return this.complete(prompt, opts, signal, counters, recordStep);
        },
      },
      wire: this.d.wire,
      net: guard(this.d.net, "net.fetch"),
      directives: this.d.directivesSvc,
      records: guard(this.d.recordsSvc, "records"),
      secrets: {
        get: async (key) => {
          this.d.auditSvc.log(reg.pluginId, "secret.read", key);
          return this.d.secrets.get(key);
        },
        set: (key, value) => this.d.secrets.set(key, value),
        delete: (key) => this.d.secrets.delete(key),
      },
      log: {
        info: (m) => console.log(`[${reg.pluginId}] ${m}`),
        warn: (m) => console.warn(`[${reg.pluginId}] ${m}`),
        error: (m) => console.error(`[${reg.pluginId}] ${m}`),
      },
      // self-reference is safe: the closure only runs after `ctx` is constructed
      runAgent: (req) => this.runAgent(req, reg, ctx, recordStep, counters, signal),
      step: (name, detail = "") => recordStep("note", name, detail, null),
      signal,
    };
    return ctx;
  }

  /* ------------------------------------------------------------------ */
  /* LLM paths                                                           */
  /* ------------------------------------------------------------------ */

  private async complete(
    prompt: string,
    opts: { system?: string; maxTokens?: number } | undefined,
    signal: AbortSignal,
    counters: RunSummary,
    recordStep: (
      kind: "model" | "tool" | "note",
      name: string,
      detail: string,
      ms: number | null,
    ) => void,
  ): Promise<Result<string>> {
    if (this.d.ollama.state !== "ready") {
      return err(
        "OLLAMA_UNAVAILABLE",
        "Local model is not available. Install Ollama and pull the tier models (free).",
      );
    }
    const t0 = performance.now();
    try {
      const result = streamText({
        model: this.d.ollama.chatModel(),
        system: opts?.system,
        prompt,
        maxTokens: opts?.maxTokens ?? 900,
        abortSignal: signal,
      });
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.textDelta;
          this.d.bus.emit("run.token", { runId: counters.id, token: part.textDelta });
        }
      }
      const usage = await result.usage;
      counters.tokensIn += usage.promptTokens ?? 0;
      counters.tokensOut += usage.completionTokens ?? 0;
      const ms = performance.now() - t0;
      this.d.ollama.reportLatency(ms);
      recordStep("model", this.d.ollama.activeModel, `complete (${Math.round(ms)}ms)`, ms);
      return ok(text);
    } catch (e) {
      return err("LLM_FAIL", e instanceof Error ? e.message : String(e), e);
    }
  }

  private async runAgent(
    req: AgentRunRequest,
    reg: RegisteredIntent,
    ctx: RunContext,
    recordStep: (
      kind: "model" | "tool" | "note",
      name: string,
      detail: string,
      ms: number | null,
    ) => void,
    counters: RunSummary,
    signal: AbortSignal,
  ): Promise<Result<AgentRunResult>> {
    if (this.d.ollama.state !== "ready") {
      return err(
        "OLLAMA_UNAVAILABLE",
        "Local model is not available. Install Ollama and pull the tier models (free).",
      );
    }
    const profile = AGENTS[req.agent as AgentName];
    if (!profile) return err("AGENT_UNKNOWN", `unknown agent "${req.agent}"`);

    const allow = new Set(req.tools ?? profile.tools);
    const toolMap: Record<string, CoreTool> = {};
    for (const name of allow) {
      const rt = this.tools.get(name);
      if (!rt) continue; // tool not registered (e.g. integration disabled) → simply not offered
      const toolName = name.replace(/\./g, "_"); // model-safe name
      toolMap[toolName] = tool({
        description: rt.spec.description,
        parameters: rt.spec.inputSchema,
        execute: async (args: unknown) => {
          this.requireGrant(reg, rt.spec.capability, name);
          this.d.auditSvc.log(reg.pluginId, `tool:${name}`, ctx.intentKey, { runId: ctx.runId });
          const t0 = performance.now();
          const parsed = rt.spec.inputSchema.safeParse(args);
          if (!parsed.success) return `Invalid tool input: ${parsed.error.message}`;
          const res = await rt.spec.execute(parsed.data, ctx);
          recordStep("tool", name, res.ok ? "ok" : res.error.message, performance.now() - t0);
          return res.ok ? res.value : `TOOL ERROR: ${res.error.message}`;
        },
      }) as unknown as CoreTool;
    }

    // TWO-BLOCK PROMPT: the byte-stable brain prefix leads (identity + core
    // knowledge + capabilities → Ollama KV prefix-cache reuse), the agent's
    // role sits in the middle, and the small always-fresh dynamic block
    // (time, optional personality checkpoint) closes. The full personality
    // rides on EVERY agent turn — that constant presence is the anti-drift.
    const system = [
      this.d.brain.stableBlock(),
      profile.system,
      this.d.brain.dynamicBlock({ checkpoint: req.checkpoint ?? false }),
    ].join("\n\n");

    const t0 = performance.now();
    try {
      const result = streamText({
        model: this.d.ollama.chatModel(),
        system,
        prompt: req.brief,
        tools: toolMap,
        maxSteps: req.maxSteps ?? profile.maxSteps,
        abortSignal: signal,
      });
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.textDelta;
          this.d.bus.emit("run.token", { runId: ctx.runId, token: part.textDelta });
        }
      }
      const usage = await result.usage;
      const steps = await result.steps;
      counters.tokensIn += usage.promptTokens ?? 0;
      counters.tokensOut += usage.completionTokens ?? 0;
      const ms = performance.now() - t0;
      this.d.ollama.reportLatency(ms);
      recordStep(
        "model",
        this.d.ollama.activeModel,
        `${req.agent} loop (${steps.length} steps, ${Math.round(ms)}ms)`,
        ms,
      );
      return ok({
        text,
        tokensIn: usage.promptTokens ?? 0,
        tokensOut: usage.completionTokens ?? 0,
        steps: steps.length,
      });
    } catch (e) {
      return err("AGENT_FAIL", e instanceof Error ? e.message : String(e), e);
    }
  }
}
