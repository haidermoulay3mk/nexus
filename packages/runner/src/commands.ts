import type { CommandSpec } from "@nexus/plugin-sdk";

/**
 * Deterministic command router.
 *
 * The ⌘K palette and voice both funnel free text into `nexus.command`.
 * Before that text ever reaches an LLM, this router checks its FIRST WORD
 * against the prefixes plugins registered (`paper`, `course`, `agency`, …).
 * On a hit the full line is re-enqueued to the owning intent, whose handler
 * parses it with plain TypeScript.
 *
 * This is the load-bearing durability property of Nexus: every tracking
 * operation works identically with a 3B model, a broken model, or NO model.
 */
export class CommandRouter {
  private byPrefix = new Map<string, CommandSpec>();

  register(specs: CommandSpec[] | undefined): void {
    for (const spec of specs ?? []) {
      this.byPrefix.set(spec.prefix.toLowerCase(), spec);
    }
  }

  /** Match a command line to a registered prefix (first token, case-insensitive). */
  route(input: string): CommandSpec | null {
    const first = input.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return this.byPrefix.get(first) ?? null;
  }

  /** All registered commands, alphabetical — powers the `help` output. */
  list(): CommandSpec[] {
    return [...this.byPrefix.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
  }
}
