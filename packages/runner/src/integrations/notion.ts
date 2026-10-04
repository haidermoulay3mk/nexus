import { type Result, err, ok } from "@nexus/core";
import type { SecretService } from "../services";

/**
 * Notion via a free **internal integration token** (paste-in, no OAuth
 * needed, works on Notion's free plan). Raw REST keeps the Runner light;
 * the token lives only in the secret vault.
 */
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export class NotionIntegration {
  constructor(private readonly secrets: SecretService) {}

  async isConnected(): Promise<boolean> {
    return (await this.secrets.get("notion.token")) !== null;
  }

  async connect(token: string): Promise<Result<string>> {
    // Validate by hitting /users/me before storing.
    try {
      const res = await fetch(`${API}/users/me`, {
        headers: this.headers(token),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return err("NOTION_AUTH", `token rejected (${res.status})`);
      const me = (await res.json()) as {
        name?: string;
        bot?: { owner?: { user?: { name?: string } } };
      };
      await this.secrets.set("notion.token", token);
      return ok(me.name ?? "Notion workspace");
    } catch (e) {
      return err("NOTION_OFFLINE", "Notion unreachable (offline?)", e);
    }
  }

  async disconnect(): Promise<void> {
    await this.secrets.delete("notion.token");
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "notion-version": VERSION,
      "content-type": "application/json",
    };
  }

  async search(query: string): Promise<Result<Array<{ id: string; title: string; url: string }>>> {
    const token = await this.secrets.get("notion.token");
    if (!token) return err("NOTION_NOT_CONNECTED", "Notion is not connected");
    try {
      const res = await fetch(`${API}/search`, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({ query, page_size: 8 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return err("NOTION_HTTP", `search failed: ${res.status}`);
      const data = (await res.json()) as {
        results?: Array<{
          id: string;
          url?: string;
          properties?: Record<string, { title?: Array<{ plain_text: string }> }>;
          title?: Array<{ plain_text: string }>;
        }>;
      };
      return ok(
        (data.results ?? []).map((r) => {
          const titleProp = r.properties
            ? Object.values(r.properties).find((p) => p.title)?.title
            : r.title;
          return {
            id: r.id,
            title: titleProp?.map((t) => t.plain_text).join("") || "(untitled)",
            url: r.url ?? "",
          };
        }),
      );
    } catch (e) {
      return err("NOTION_OFFLINE", "Notion unreachable (offline?)", e);
    }
  }

  async createPage(parentPageId: string, title: string, bodyMd: string): Promise<Result<string>> {
    const token = await this.secrets.get("notion.token");
    if (!token) return err("NOTION_NOT_CONNECTED", "Notion is not connected");
    // Markdown → simple paragraph blocks (one per line, headings preserved).
    const blocks = bodyMd
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 90)
      .map((line) => {
        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h?.[1] && h[2] !== undefined) {
          const level = h[1].length as 1 | 2 | 3;
          const type = `heading_${level}` as const;
          return {
            object: "block",
            type,
            [type]: { rich_text: [{ type: "text", text: { content: h[2] } }] },
          };
        }
        return {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 1900) } }] },
        };
      });
    try {
      const res = await fetch(`${API}/pages`, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({
          parent: { page_id: parentPageId },
          properties: { title: { title: [{ type: "text", text: { content: title } }] } },
          children: blocks,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok)
        return err("NOTION_HTTP", `page create failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { id: string };
      return ok(data.id);
    } catch (e) {
      return err("NOTION_OFFLINE", "Notion unreachable (offline?)", e);
    }
  }
}
