import { AGENT, INTENT, err, ok } from "@nexus/core";
import {
  type IntentResult,
  type NexusPlugin,
  type RunContext,
  definePlugin,
} from "@nexus/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_FEEDS,
  DEFAULT_RULES,
  type FilterRules,
  itemId,
  matchesRules,
  parseFeed,
} from "./feeds";

/**
 * SCHOLARSHIPS plugin — daily worldwide undergraduate scholarship sweep.
 *
 * Free RSS feeds → code-level filter → deduped records → digest document.
 * No LLM anywhere: filtering is keyword rules the operator can edit with
 * `scholar kw …`, never model judgment.
 *
 * Collections:
 *   schol.items   id = fnv1a(link)  → item + starred/seen flags
 *   schol.config  id "config"      → { feeds, rules }
 */

const COL_ITEMS = "schol.items";
const COL_CONFIG = "schol.config";

const ItemZ = z.object({
  title: z.string(),
  link: z.string(),
  source: z.string(),
  published: z.string(),
  snippet: z.string(),
  foundAt: z.string(),
  starred: z.boolean(),
  seen: z.boolean(),
});
type Item = z.infer<typeof ItemZ>;

const ConfigZ = z.object({
  feeds: z.array(z.string()),
  rules: z.object({
    include: z.array(z.string()),
    postgrad: z.array(z.string()),
    undergrad: z.array(z.string()),
  }),
  feedStatus: z
    .record(
      z.string(),
      z.object({
        ok: z.boolean(),
        at: z.string(),
        found: z.number(),
        error: z.string().nullable(),
      }),
    )
    .default({}),
});
type Config = z.infer<typeof ConfigZ>;

const DEFAULT_CONFIG: Config = { feeds: DEFAULT_FEEDS, rules: DEFAULT_RULES, feedStatus: {} };

const now = () => new Date().toISOString();

async function loadConfig(ctx: RunContext): Promise<Config> {
  const row = await ctx.records.get(COL_CONFIG, "config");
  const parsed = ConfigZ.safeParse(row?.data);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_CONFIG);
}

async function loadItems(ctx: RunContext): Promise<Array<Item & { id: string }>> {
  const rows = await ctx.records.list(COL_ITEMS);
  const out: Array<Item & { id: string }> = [];
  for (const row of rows) {
    const parsed = ItemZ.safeParse(row.data);
    if (parsed.success) out.push({ ...parsed.data, id: row.id });
  }
  out.sort((a, b) => (b.published || b.foundAt).localeCompare(a.published || a.foundAt));
  return out;
}

const doc = (
  title: string,
  bodyMd: string,
  wire: string[] = [],
  speak: string | null = null,
): IntentResult => ({
  document: { kind: "scholarships", title, bodyMd },
  speak,
  wire,
});

const fmtItem = (i: Item & { id: string }): string =>
  `- ${i.starred ? "⭐ " : ""}**[${i.title}](${i.link})** \`${i.id}\` — ${i.source}${i.published ? ` · ${i.published}` : ""}`;

async function runSweep(ctx: RunContext): Promise<IntentResult> {
  const config = await loadConfig(ctx);
  const rules: FilterRules = config.rules;
  const fresh: Array<Item & { id: string }> = [];
  let checked = 0;

  for (const url of config.feeds) {
    ctx.step("fetch", url);
    const res = await ctx.net.fetchCached(`schol:${url}`, url, 3600 * 20);
    if (!res.ok) {
      config.feedStatus[url] = {
        ok: false,
        at: now(),
        found: 0,
        error: res.error.message.slice(0, 120),
      };
      continue;
    }
    const items = parseFeed(res.value.body);
    let found = 0;
    for (const item of items) {
      checked += 1;
      if (!matchesRules(item, rules)) continue;
      const id = itemId(item.link);
      if (await ctx.records.get(COL_ITEMS, id)) continue; // already known
      const source = new URL(url).hostname.replace(/^www\./, "");
      const rec: Item = {
        title: item.title,
        link: item.link,
        source,
        published: item.published,
        snippet: item.snippet,
        foundAt: now(),
        starred: false,
        seen: false,
      };
      await ctx.records.put(COL_ITEMS, id, rec);
      fresh.push({ ...rec, id });
      found += 1;
    }
    config.feedStatus[url] = { ok: true, at: now(), found, error: null };
  }
  await ctx.records.put(COL_CONFIG, "config", config);

  const total = await ctx.records.count(COL_ITEMS);
  await ctx.metrics.record("schol.new", "NEW SCHOLARSHIPS", fresh.length, "");
  await ctx.metrics.record("schol.total", "SCHOLARSHIPS TRACKED", total, "");

  const deadFeeds = Object.entries(config.feedStatus).filter(([, s]) => !s.ok);
  const body = [
    `Checked **${checked}** items across **${config.feeds.length}** feeds → **${fresh.length} new** matches (tracked total: ${total}).`,
    "",
    ...(fresh.length > 0 ? ["## NEW", ...fresh.map(fmtItem)] : ["No new scholarships today."]),
    "",
    ...(deadFeeds.length > 0
      ? [
          "## FEED PROBLEMS",
          ...deadFeeds.map(([u, s]) => `- ${u} — ${s.error ?? "failed"}`),
          "",
          "Fix or remove with `scholar feed rm <url>`.",
        ]
      : []),
    "_Star anything worth applying to: `scholar star <id>`._",
  ].join("\n");

  return doc(
    `Scholarship Sweep — ${now().slice(0, 10)}`,
    body,
    fresh.slice(0, 3).map((i) => `SCHOL · ${i.title.slice(0, 70)}`),
    fresh.length > 0 ? `${fresh.length} new scholarships found.` : null,
  );
}

async function handleCommand(ctx: RunContext): Promise<IntentResult> {
  const tokens = (ctx.input ?? "").trim().split(/\s+/).slice(1); // drop "scholar"
  const sub = (tokens[0] ?? "new").toLowerCase();

  if (sub === "sweep") return runSweep(ctx);

  if (sub === "new" || sub === "") {
    const items = (await loadItems(ctx)).filter((i) => !i.seen).slice(0, 25);
    if (items.length === 0)
      return doc(
        "Scholarships — nothing new",
        "No unseen scholarships. Run `scholar sweep` to check feeds now.",
      );
    for (const { id, ...data } of items)
      await ctx.records.put(COL_ITEMS, id, { ...data, seen: true });
    return doc(
      `Scholarships — ${items.length} new`,
      [...items.map(fmtItem), "", "_Marked as seen. Star keepers: `scholar star <id>`._"].join(
        "\n",
      ),
    );
  }

  if (sub === "list") {
    const n = Math.min(Number(tokens[1]) || 20, 100);
    const items = (await loadItems(ctx)).slice(0, n);
    return doc(
      `Scholarships — latest ${items.length}`,
      items.length > 0
        ? items.map(fmtItem).join("\n")
        : "Nothing tracked yet — run `scholar sweep`.",
    );
  }

  if (sub === "starred") {
    const items = (await loadItems(ctx)).filter((i) => i.starred);
    return doc(
      `Scholarships — ${items.length} starred`,
      items.length > 0
        ? items.map(fmtItem).join("\n")
        : "Nothing starred. Star with `scholar star <id>`.",
    );
  }

  if (sub === "star" || sub === "unstar") {
    const id = (tokens[1] ?? "").toLowerCase();
    const row = await ctx.records.get(COL_ITEMS, id);
    const parsed = ItemZ.safeParse(row?.data);
    if (!parsed.success)
      return doc(
        "Scholarships — unknown id",
        `No item \`${id}\`. Ids are shown in \`scholar list\`.`,
      );
    await ctx.records.put(COL_ITEMS, id, { ...parsed.data, starred: sub === "star", seen: true });
    return doc(
      `${sub === "star" ? "Starred" : "Unstarred"}: ${parsed.data.title.slice(0, 60)}`,
      `[${parsed.data.title}](${parsed.data.link})`,
      [`SCHOL · ${sub} ${id}`],
    );
  }

  if (sub === "feeds") {
    const config = await loadConfig(ctx);
    const lines = config.feeds.map((u) => {
      const s = config.feedStatus[u];
      return `- ${u} — ${s ? (s.ok ? `OK (${s.found} new last sweep, ${s.at.slice(0, 10)})` : `FAILING: ${s.error}`) : "never swept"}`;
    });
    return doc(
      "Scholarship feeds",
      [...lines, "", "Manage: `scholar feed add <url>` · `scholar feed rm <url>`"].join("\n"),
    );
  }

  if (sub === "feed") {
    const action = (tokens[1] ?? "").toLowerCase();
    const url = tokens[2] ?? "";
    if ((action !== "add" && action !== "rm") || !/^https?:\/\//.test(url))
      return doc(
        "Scholarships — bad command",
        "usage: `scholar feed add https://site/feed/` or `scholar feed rm <url>`",
      );
    const config = await loadConfig(ctx);
    config.feeds =
      action === "add"
        ? [...new Set([...config.feeds, url])]
        : config.feeds.filter((f) => f !== url);
    await ctx.records.put(COL_CONFIG, "config", config);
    return doc(`Feed ${action === "add" ? "added" : "removed"}`, url, [
      `SCHOL · feed ${action} ${url}`,
    ]);
  }

  if (sub === "kw") {
    const config = await loadConfig(ctx);
    const listName = (tokens[1] ?? "").toLowerCase();
    const action = (tokens[2] ?? "").toLowerCase();
    const word = tokens.slice(3).join(" ").toLowerCase();
    if (
      (listName === "include" || listName === "postgrad" || listName === "undergrad") &&
      (action === "add" || action === "rm") &&
      word
    ) {
      const list = config.rules[listName];
      config.rules[listName] =
        action === "add" ? [...new Set([...list, word])] : list.filter((w) => w !== word);
      await ctx.records.put(COL_CONFIG, "config", config);
      return doc("Filter updated", `\`${listName}\` ${action} **${word}**`);
    }
    return doc(
      "Scholarship filter rules",
      [
        `**include** (must match one): ${config.rules.include.join(", ")}`,
        `**postgrad** (excluded unless undergrad marker present): ${config.rules.postgrad.join(", ")}`,
        `**undergrad** (rescue markers): ${config.rules.undergrad.join(", ")}`,
        "",
        "Edit: `scholar kw include add <word>` · `scholar kw postgrad rm <word>`",
      ].join("\n"),
    );
  }

  return doc(
    "Scholarships — commands",
    [
      "| COMMAND | WHAT |",
      "|---|---|",
      "| `scholar` / `scholar new` | Unseen finds (marks them seen) |",
      "| `scholar sweep` | Sweep all feeds now |",
      "| `scholar list [n]` | Latest n tracked |",
      "| `scholar star <id>` / `unstar <id>` | Keep / unkeep |",
      "| `scholar starred` | Your shortlist |",
      "| `scholar feeds` / `feed add/rm <url>` | Manage sources |",
      "| `scholar kw` | View/edit filter keywords |",
    ].join("\n"),
  );
}

export function createScholarshipsPlugin(): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.scholarships",
      name: "Scholarships",
      version: "0.1.0",
      description:
        "Daily undergraduate scholarship sweep from free feeds. Keyword-filtered by code, not AI.",
      capabilities: ["records", "net.fetch", "fs.documents", "metrics.read", "metrics.write"],
      optional: true,
    },
    tools: [],
    scheduledJobs: [],
    commands: [
      {
        prefix: "scholar",
        intentKey: INTENT.SCHOLAR_CMD,
        usage: "scholar [new|sweep|list|star <id>|feeds|kw]",
        description: "Scholarship tracker",
      },
    ],
    intents: [
      {
        key: INTENT.SCHOLAR_SWEEP,
        label: "SCHOLAR SWEEP",
        agent: AGENT.SYSTEM,
        description:
          "Sweep free scholarship feeds worldwide; dedupe and digest new undergraduate matches. Runs daily 08:30.",
        scheduleCron: "30 8 * * *",
        requiresIntegration: null,
        async handler(ctx) {
          try {
            return ok(await runSweep(ctx));
          } catch (e) {
            return err("SCHOL_SWEEP", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        key: INTENT.SCHOLAR_CMD,
        label: "SCHOLAR CMD",
        agent: AGENT.SYSTEM,
        description: "Typed scholarship commands — parsed by code, no AI.",
        scheduleCron: null,
        requiresIntegration: null,
        hidden: true,
        async handler(ctx) {
          try {
            return ok(await handleCommand(ctx));
          } catch (e) {
            return err("SCHOL_CMD", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ],
  });
}
