import { AGENT, INTENT, type Result, err, ok } from "@nexus/core";
import { type NexusPlugin, definePlugin } from "@nexus/plugin-sdk";
import { z } from "zod";

/**
 * EMAIL plugin — INBOX BRIEF intent + `email.headers` tool.
 * Providers (optional + free): Gmail (OAuth loopback) or any IMAP server
 * (imapflow, e.g. with a free app password). Headers only — bodies never
 * leave the mail server through Nexus. Cached for offline triage.
 */

type Header = { from: string; subject: string; date: string };

interface EmailHub {
  google: {
    isConnected(): Promise<boolean>;
    gmailHeaders(limit?: number): Promise<Result<Header[]>>;
    createDraft(to: string, subject: string, body: string): Promise<Result<string>>;
  };
}

export function createEmailPlugin(deps: { hub: EmailHub }): NexusPlugin {
  const fetchHeaders = async (ctx: {
    secrets: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };
  }): Promise<Result<{ headers: Header[]; fromCache: boolean }>> => {
    if (await deps.hub.google.isConnected()) {
      const res = await deps.hub.google.gmailHeaders(15);
      if (res.ok) {
        await ctx.secrets.set("cache.email.headers", JSON.stringify(res.value));
        return ok({ headers: res.value, fromCache: false });
      }
    }
    const imapHost = await ctx.secrets.get("imap.host");
    if (imapHost) {
      const res = await imapHeaders(ctx, imapHost);
      if (res.ok) {
        await ctx.secrets.set("cache.email.headers", JSON.stringify(res.value));
        return ok({ headers: res.value, fromCache: false });
      }
    }
    const cached = await ctx.secrets.get("cache.email.headers");
    if (cached) {
      try {
        return ok({ headers: JSON.parse(cached) as Header[], fromCache: true });
      } catch {
        /* fall through */
      }
    }
    return err(
      "EMAIL_NOT_CONNECTED",
      "No email connected (optional — link Gmail or IMAP in Settings).",
    );
  };

  return definePlugin({
    manifest: {
      id: "nexus.email",
      name: "Email",
      version: "0.2.0",
      description:
        "Inbox triage + confirm-gated draft writing via Gmail or IMAP (both optional, free).",
      capabilities: ["email", "memory.read", "fs.documents", "llm.chat"],
      secretKeys: ["imap.host", "imap.port", "imap.user", "imap.pass"],
    },
    commands: [
      {
        prefix: "email",
        intentKey: INTENT.EMAIL_DRAFT,
        usage: "email draft <to> | <subject> | <points to make>",
        description: "Write a DRAFT (never sends — you review it in Gmail)",
      },
    ],
    scheduledJobs: [],
    tools: [
      {
        name: "email.headers",
        description: "Recent inbox headers (from/subject/date only) for triage.",
        capability: "email",
        inputSchema: z.object({}),
        async execute(_input, ctx) {
          const res = await fetchHeaders(ctx);
          if (!res.ok) return res;
          const { headers, fromCache } = res.value;
          if (headers.length === 0) return ok("Inbox is empty.");
          return ok(
            headers.map((h) => `- ${h.date.slice(0, 16)} | ${h.from} | ${h.subject}`).join("\n") +
              (fromCache ? "\n(cached — offline)" : ""),
          );
        },
      },
    ],
    intents: [
      {
        key: INTENT.INBOX_BRIEF,
        label: "INBOX BRIEF",
        agent: AGENT.INBOX,
        description: "Triage recent inbox headers into ACT NOW / REPLY TODAY / IGNORE.",
        scheduleCron: null,
        requiresIntegration: "email",
        async handler(ctx) {
          ctx.step("fetch", "inbox headers");
          const res = await fetchHeaders(ctx);
          if (!res.ok) {
            return ok({
              document: {
                kind: "brief",
                title: "Inbox Brief — connect to enable",
                bodyMd:
                  "## NOT CONNECTED\n\nLink **Gmail** (free OAuth) or any **IMAP** account (free app password) in Settings → Integrations to enable inbox triage.\n\nNexus reads *headers only* and works from cache when offline.",
              },
              speak: null,
              wire: [],
            });
          }
          const agent = await ctx.runAgent({
            agent: AGENT.INBOX,
            brief: `Triage these inbox headers${res.value.fromCache ? " (cached, offline)" : ""}:\n${res.value.headers
              .map((h) => `- ${h.date.slice(0, 16)} | ${h.from} | ${h.subject}`)
              .join("\n")}\n\nBuckets: ACT NOW / REPLY TODAY / IGNORE. Two lines max per item.`,
            tools: ["email.headers", "memory.search"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: {
              kind: "brief",
              title: `Inbox Brief — ${new Date().toISOString().slice(0, 10)}`,
              bodyMd: agent.value.text,
            },
            speak: "Inbox brief ready.",
            wire: [`INBOX · ${res.value.headers.length} headers triaged`],
          });
        },
      },
      {
        key: INTENT.EMAIL_DRAFT,
        label: "EMAIL DRAFT",
        agent: AGENT.SCRIBE,
        description:
          "Compose a Gmail DRAFT from `email draft <to> | <subject> | <points>`. Never sends — you review in Gmail.",
        scheduleCron: null,
        requiresIntegration: "email",
        hidden: true,
        async handler(ctx) {
          // Deterministic parse — the LLM never decides the recipient/subject.
          const rest = (ctx.input ?? "").replace(/^\S+\s+draft\s+/i, "");
          const parts = rest.split("|").map((s) => s.trim());
          const [to, subject, points] = [
            parts[0] ?? "",
            parts[1] ?? "",
            parts.slice(2).join(" | ") || parts[2] || "",
          ];
          if (!to || !subject || !points || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
            return ok({
              document: {
                kind: "email",
                title: "Email draft — usage",
                bodyMd:
                  "usage: `email draft <to> | <subject> | <points to make>`\n\nExample: `email draft prof@uni.edu | Recommendation letter | asking for a reference for my UCL application, deadline Jan 15`\n\nNexus writes a **draft** in Gmail — it never sends. You review and send it yourself.",
              },
              speak: null,
              wire: [],
            });
          }
          if (!(await deps.hub.google.isConnected())) {
            return ok({
              document: {
                kind: "email",
                title: "Email draft — connect Gmail",
                bodyMd:
                  "Draft writing needs **Gmail** connected (Settings → Integrations). IMAP can read headers but not save Gmail drafts.",
              },
              speak: null,
              wire: [],
            });
          }

          // Compose the body with the model when available; degrade to a plain
          // templated body when Ollama is down so the feature never hard-fails.
          ctx.step("compose", subject);
          let body: string;
          const agent = await ctx.runAgent({
            agent: AGENT.SCRIBE,
            brief: `Write a concise, polite email body (no subject line, no "Subject:" header).
Recipient: ${to}
Subject: ${subject}
Points to cover: ${points}

Rules: plain text, 60–150 words, first-person, sign off as the sender without inventing a name (use "Best regards,"). Do not fabricate facts beyond the points given.`,
            tools: [],
          });
          if (agent.ok && agent.value.text.trim().length > 0) {
            body = agent.value.text.trim();
          } else {
            body = `Hello,\n\n${points}\n\nBest regards,`;
          }

          const draft = await deps.hub.google.createDraft(to, subject, body);
          if (!draft.ok) {
            return ok({
              document: {
                kind: "email",
                title: "Email draft — failed",
                bodyMd: `Could not save the draft: ${draft.error.message}`,
              },
              speak: null,
              wire: ["EMAIL · draft failed"],
            });
          }
          return ok({
            document: {
              kind: "email",
              title: `Draft saved — ${subject}`,
              bodyMd: `**Saved to Gmail Drafts** (not sent).\n\n**To:** ${to}\n**Subject:** ${subject}\n\n---\n\n${body}\n\n---\n\n_Open Gmail → Drafts to review, edit, and send._`,
            },
            speak: "Draft saved to Gmail. Review before sending.",
            wire: [`EMAIL · draft → ${to}`],
          });
        },
      },
    ],
  });

  async function imapHeaders(
    ctx: { secrets: { get(k: string): Promise<string | null> } },
    host: string,
  ): Promise<Result<Header[]>> {
    try {
      const { ImapFlow } = await import("imapflow");
      const client = new ImapFlow({
        host,
        port: Number((await ctx.secrets.get("imap.port")) ?? 993),
        secure: true,
        auth: {
          user: (await ctx.secrets.get("imap.user")) ?? "",
          pass: (await ctx.secrets.get("imap.pass")) ?? "",
        },
        logger: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      const headers: Header[] = [];
      try {
        const mailbox = client.mailbox;
        const total = typeof mailbox === "object" && mailbox ? mailbox.exists : 0;
        const from = Math.max(1, total - 14);
        for await (const msg of client.fetch(`${from}:*`, { envelope: true })) {
          const env = msg.envelope;
          headers.push({
            from: env?.from?.[0]?.address ?? "unknown",
            subject: env?.subject ?? "(no subject)",
            date: env?.date?.toISOString() ?? "",
          });
        }
      } finally {
        lock.release();
      }
      await client.logout();
      return ok(headers.reverse());
    } catch (e) {
      return err("IMAP_FAIL", e instanceof Error ? e.message : String(e), e);
    }
  }
}
