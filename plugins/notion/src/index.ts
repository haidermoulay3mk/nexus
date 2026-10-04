import { type Result, err, ok } from "@nexus/core";
import { type NexusPlugin, definePlugin } from "@nexus/plugin-sdk";
import { z } from "zod";

/**
 * NOTION plugin — Curator tools over a free internal-integration token.
 * Tool-only (no deck intent): the Curator agent and free-form commands use
 * these to search/publish. Fully optional; Nexus never requires it.
 */

interface NotionHub {
  notion: {
    isConnected(): Promise<boolean>;
    search(query: string): Promise<Result<Array<{ id: string; title: string; url: string }>>>;
    createPage(parentPageId: string, title: string, bodyMd: string): Promise<Result<string>>;
  };
}

export function createNotionPlugin(deps: { hub: NotionHub }): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.notion",
      name: "Notion",
      version: "0.1.0",
      description: "Publish and search Notion pages (free internal integration token).",
      capabilities: ["notion", "memory.read", "fs.documents"],
      secretKeys: ["notion.token", "notion.parent_page"],
    },
    intents: [],
    scheduledJobs: [],
    tools: [
      {
        name: "notion.search",
        description: "Search Notion pages shared with the Nexus integration.",
        capability: "notion",
        inputSchema: z.object({ query: z.string().min(1) }),
        async execute(input) {
          if (!(await deps.hub.notion.isConnected())) {
            return ok(
              "Notion is not connected. (Optional — paste a free internal integration token in Settings.)",
            );
          }
          const res = await deps.hub.notion.search(input.query);
          if (!res.ok) return res;
          if (res.value.length === 0) return ok("No matching pages.");
          return ok(res.value.map((p) => `- ${p.title} (${p.id})`).join("\n"));
        },
      },
      {
        name: "notion.createPage",
        description: "Create a Notion page under the configured parent page.",
        capability: "notion",
        inputSchema: z.object({ title: z.string().min(1), bodyMd: z.string().min(1) }),
        async execute(input, ctx) {
          if (!(await deps.hub.notion.isConnected())) {
            return err("NOTION_NOT_CONNECTED", "Notion is not connected (optional integration).");
          }
          const parent = await ctx.secrets.get("notion.parent_page");
          if (!parent)
            return err("NOTION_NO_PARENT", "Set a parent page ID in Settings → Notion first.");
          const res = await deps.hub.notion.createPage(parent, input.title, input.bodyMd);
          if (!res.ok) return res;
          return ok(`Created Notion page ${res.value}.`);
        },
      },
    ],
  });
}
