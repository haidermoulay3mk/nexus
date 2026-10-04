import { randomUUID } from "node:crypto";
import type { QueueStatus, RunSummary } from "@nexus/core";
import type { DbHandle } from "@nexus/db";
import { tasks } from "@nexus/db";
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { EventBus } from "../bus";
import type { Orchestrator } from "../orchestrator";

const now = () => new Date().toISOString();

/**
 * Durable task queue backed by SQLite. Intents write to the queue; the
 * Runner drains it with bounded concurrency. Tasks survive restarts —
 * anything left `active` at boot is re-queued.
 */
export class TaskQueue {
  private draining = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
    private readonly orchestrator: Orchestrator,
    private readonly maxConcurrent: number,
    private readonly onStatusChange: () => void,
  ) {}

  start(): void {
    // Crash recovery: reclaim tasks that were mid-flight.
    this.handle.db.update(tasks).set({ status: "queued" }).where(eq(tasks.status, "active")).run();
    this.timer = setInterval(() => void this.drain(), 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(
    intentKey: string,
    payload: string | null,
    opts?: { priority?: number; scheduledFor?: string },
  ): string {
    const id = randomUUID();
    this.handle.db
      .insert(tasks)
      .values({
        id,
        intentKey,
        payloadJson: JSON.stringify(payload),
        status: "queued",
        priority: opts?.priority ?? 0,
        scheduledFor: opts?.scheduledFor ?? null,
        createdAt: now(),
      })
      .run();
    const summary: RunSummary = {
      id,
      intentKey,
      agent: this.orchestrator.getIntent(intentKey)?.spec.agent ?? "system",
      status: "queued",
      startedAt: null,
      endedAt: null,
      tokensIn: 0,
      tokensOut: 0,
      error: null,
    };
    this.bus.emit("run.queued", summary);
    this.onStatusChange();
    void this.drain();
    return id;
  }

  status(): QueueStatus {
    const queued = this.handle.db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "queued"))
      .all().length;
    return {
      active: this.orchestrator.activeCount,
      queued,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.orchestrator.activeCount < this.maxConcurrent) {
        const next = this.handle.db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.status, "queued"),
              or(isNull(tasks.scheduledFor), lte(tasks.scheduledFor, now())),
            ),
          )
          .orderBy(desc(tasks.priority), asc(tasks.createdAt))
          .limit(1)
          .all()[0];
        if (!next) break;

        this.handle.db
          .update(tasks)
          .set({ status: "active", attempts: next.attempts + 1 })
          .where(eq(tasks.id, next.id))
          .run();
        this.onStatusChange();

        const input = JSON.parse(next.payloadJson) as string | null;
        // Execute without awaiting sequentially — allow concurrency up to the cap.
        void this.orchestrator
          .execute(next.intentKey, input)
          .then((res) => {
            this.handle.db
              .update(tasks)
              .set({ status: res.ok ? "done" : "failed", runId: res.ok ? res.value.id : null })
              .where(eq(tasks.id, next.id))
              .run();
          })
          .catch((e) => {
            console.error(`[queue] task ${next.id} crashed:`, e);
            this.handle.db
              .update(tasks)
              .set({ status: "failed" })
              .where(eq(tasks.id, next.id))
              .run();
          })
          .finally(() => this.onStatusChange());
        // Yield so activeCount updates before the next loop check.
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.draining = false;
    }
  }
}
