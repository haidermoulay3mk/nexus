import type { ScheduledJobSpec } from "@nexus/plugin-sdk";
import { Cron } from "croner";
import type { TaskQueue } from "../queue";

/**
 * Cron-style scheduling (croner — free, no daemon). Every scheduled job
 * simply enqueues its intent; the queue provides durability + concurrency.
 */
export class Scheduler {
  private jobs: Cron[] = [];

  constructor(private readonly queue: TaskQueue) {}

  register(specs: ScheduledJobSpec[]): void {
    for (const spec of specs) {
      const job = new Cron(spec.cron, { name: spec.id, protect: true }, () => {
        this.queue.enqueue(spec.intentKey, null, { priority: 1 });
      });
      this.jobs.push(job);
    }
  }

  stop(): void {
    for (const j of this.jobs) j.stop();
    this.jobs = [];
  }

  list(): Array<{ id: string; next: string | null }> {
    return this.jobs.map((j) => ({
      id: j.name ?? "job",
      next: j.nextRun()?.toISOString() ?? null,
    }));
  }
}
