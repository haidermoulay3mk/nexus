import { AGENT, INTENT, err, ok } from "@nexus/core";
import { type NexusPlugin, type RunContext, definePlugin } from "@nexus/plugin-sdk";
import { z } from "zod";

/**
 * INTEL plugin — the AI WIRE feeders.
 * GH TRENDING (keyless GitHub trending scrape, cached), TREND SCAN (fully
 * local synthesis over memory + recent documents), YT WEEK (keyless YouTube
 * channel RSS). Everything degrades gracefully offline via the net cache.
 */

function parseGhTrending(html: string): Array<{ repo: string; desc: string }> {
  const out: Array<{ repo: string; desc: string }> = [];
  // Repo anchors look like: <a href="/owner/name" ...> inside <h2 class="h3 lh-condensed">
  const articleRe = /<article[\s\S]*?<\/article>/g;
  for (const article of html.match(articleRe) ?? []) {
    const href = article.match(/<h2[^>]*>[\s\S]*?href="\/([^"]+)"/);
    const desc = article.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (href?.[1]) {
      out.push({
        repo: href[1].trim(),
        desc: (desc?.[1] ?? "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 140),
      });
    }
    if (out.length >= 10) break;
  }
  return out;
}

function parseRssTitles(xml: string, limit = 6): Array<{ title: string; published: string }> {
  const out: Array<{ title: string; published: string }> = [];
  const entryRe = /<entry>[\s\S]*?<\/entry>/g;
  for (const entry of xml.match(entryRe) ?? []) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] ?? "";
    if (title) out.push({ title: title.trim(), published: published.slice(0, 10) });
    if (out.length >= limit) break;
  }
  return out;
}

export function createIntelPlugin(): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.intel",
      name: "Intel",
      version: "0.1.0",
      description: "GitHub trending, local trend synthesis, YouTube channel intel.",
      capabilities: [
        "memory.read",
        "memory.write",
        "fs.documents",
        "llm.chat",
        "net.fetch",
        "metrics.read",
      ],
    },
    scheduledJobs: [],
    tools: [
      {
        name: "net.ghTrending",
        description: "Fetch today's GitHub trending repositories (keyless, cached for offline).",
        capability: "net.fetch",
        inputSchema: z.object({}),
        async execute(_input, ctx) {
          const res = await ctx.net.fetchCached(
            "gh:trending",
            "https://github.com/trending",
            3600 * 6,
          );
          if (!res.ok) return err("GH_OFFLINE", "offline and no cached trending data");
          const repos = parseGhTrending(res.value.body);
          if (repos.length === 0) return ok("Could not parse trending page.");
          return ok(
            repos.map((r) => `- ${r.repo}: ${r.desc}`).join("\n") +
              (res.value.fromCache ? "\n(from cache)" : ""),
          );
        },
      },
      {
        name: "net.rss",
        description: "Fetch an RSS/Atom feed and return recent item titles (keyless, cached).",
        capability: "net.fetch",
        inputSchema: z.object({ url: z.string().url() }),
        async execute(input, ctx) {
          const res = await ctx.net.fetchCached(`rss:${input.url}`, input.url, 3600 * 3);
          if (!res.ok) return err("RSS_OFFLINE", "offline and no cached feed");
          const items = parseRssTitles(res.value.body);
          if (items.length === 0) return ok("Feed parsed but no entries found.");
          return ok(items.map((i) => `- ${i.title} (${i.published})`).join("\n"));
        },
      },
    ],
    intents: [
      {
        key: INTENT.GH_TRENDING,
        label: "GH TRENDING",
        agent: AGENT.RESEARCHER,
        description: "Scan GitHub trending and produce a terse intel brief (keyless + cached).",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("fetch", "github trending");
          const res = await ctx.net.fetchCached(
            "gh:trending",
            "https://github.com/trending",
            3600 * 6,
          );
          if (!res.ok) {
            return ok({
              document: {
                kind: "intel",
                title: "GH Trending — offline",
                bodyMd:
                  "## OFFLINE\n\nNo network and no cached trending data yet. Run again when online — results are cached for offline use.",
              },
              speak: null,
              wire: ["INTEL · gh trending unavailable offline"],
            });
          }
          const repos = parseGhTrending(res.value.body);
          for (const r of repos.slice(0, 3)) {
            await ctx.wire.append("intel", `GH · ${r.repo}`);
          }
          const agent = await ctx.runAgent({
            agent: AGENT.RESEARCHER,
            brief: `Today's GitHub trending repos${res.value.fromCache ? " (cached)" : ""}:\n${repos
              .map((r) => `- ${r.repo}: ${r.desc}`)
              .join(
                "\n",
              )}\n\nProduce an intel brief: which are signal vs noise for a builder of local-first AI tools, max 8 bullets.`,
            tools: ["memory.search", "memory.write"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: {
              kind: "intel",
              title: `GH Trending — ${new Date().toISOString().slice(0, 10)}`,
              bodyMd: agent.value.text,
            },
            speak: "GitHub trending brief ready.",
            wire: [],
          });
        },
      },
      {
        key: INTENT.TREND_SCAN,
        label: "TREND SCAN",
        agent: AGENT.RESEARCHER,
        description: "Synthesize trends from local memory and recent documents (fully offline).",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("scan", "local corpus");
          const docs = await ctx.documents.recent(15);
          const agent = await ctx.runAgent({
            agent: AGENT.RESEARCHER,
            brief: `Scan the local corpus for recurring themes and emerging threads.\n\nRECENT DOCUMENT TITLES:\n${
              docs.length > 0
                ? docs.map((d) => `- [${d.kind}] ${d.title}`).join("\n")
                : "- none yet"
            }\n\nAlso search memory for related facts. Output: 3–6 trend bullets, each with the evidence in parentheses.`,
            tools: ["memory.search", "memory.write"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: {
              kind: "intel",
              title: `Trend Scan — ${new Date().toISOString().slice(0, 10)}`,
              bodyMd: agent.value.text,
            },
            speak: "Trend scan complete.",
            wire: ["INTEL · trend scan across local corpus"],
          });
        },
      },
      {
        key: INTENT.YT_WEEK,
        label: "YT WEEK",
        agent: AGENT.RESEARCHER,
        description: "Weekly digest of configured YouTube channels via free RSS (no API key).",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          const channels = ((await ctx.secrets.get("config.yt.channels")) ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (channels.length === 0) {
            return ok({
              document: {
                kind: "intel",
                title: "YT Week — not configured",
                bodyMd:
                  "## SETUP NEEDED\n\nAdd YouTube channel IDs in Settings → Intel (comma-separated).\nNexus uses each channel's **free public RSS feed** — no API key, no cost.",
              },
              speak: null,
              wire: [],
            });
          }
          ctx.step("fetch", `${channels.length} channel feeds`);
          const sections: string[] = [];
          for (const ch of channels.slice(0, 6)) {
            const res = await ctx.net.fetchCached(
              `yt:${ch}`,
              `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch)}`,
              3600 * 6,
            );
            if (res.ok) {
              const items = parseRssTitles(res.value.body, 4);
              sections.push(
                `CHANNEL ${ch}:\n${items.map((i) => `- ${i.title} (${i.published})`).join("\n")}`,
              );
            } else {
              sections.push(`CHANNEL ${ch}: unavailable offline`);
            }
          }
          const agent = await ctx.runAgent({
            agent: AGENT.RESEARCHER,
            brief: `Weekly YouTube digest from channel feeds:\n\n${sections.join("\n\n")}\n\nSummarize what shipped this week and any notable patterns. Max 8 bullets.`,
            tools: ["memory.search"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: {
              kind: "intel",
              title: `YT Week — ${new Date().toISOString().slice(0, 10)}`,
              bodyMd: agent.value.text,
            },
            speak: "YouTube week digest ready.",
            wire: ["INTEL · yt week digest compiled"],
          });
        },
      },
    ],
  });
}
