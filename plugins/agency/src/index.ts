import { AGENT, INTENT, err, ok } from "@nexus/core";
import {
  type IntentResult,
  type NexusPlugin,
  type RunContext,
  definePlugin,
} from "@nexus/plugin-sdk";
import { z } from "zod";

/**
 * AGENCY plugin — pipeline rails for the operator's future AI agency.
 * Built ahead of need so the tracking exists from client #1.
 *
 * Pipeline: lead → (won) → client → project(s) → payment(s).
 * Everything typed, everything code-parsed. No LLM.
 *
 * Collections:
 *   agency.leads     id = slug(name)   {name, note, status(open|won|lost), addedAt, updatedAt}
 *   agency.clients   id = slug(name)   {name, note, addedAt}
 *   agency.projects  id = slug(name)   {name, client, amount, status(active|done), addedAt, updatedAt}
 *   agency.payments  id = timestamp    {client, amount, note, date}
 */

const LeadZ = z.object({
  name: z.string(),
  note: z.string(),
  status: z.enum(["open", "won", "lost"]),
  addedAt: z.string(),
  updatedAt: z.string(),
});
const ClientZ = z.object({ name: z.string(), note: z.string(), addedAt: z.string() });
const ProjectZ = z.object({
  name: z.string(),
  client: z.string(),
  amount: z.number(),
  status: z.enum(["active", "done"]),
  addedAt: z.string(),
  updatedAt: z.string(),
});
const PaymentZ = z.object({
  client: z.string(),
  amount: z.number(),
  note: z.string(),
  date: z.string(),
});

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
const today = () => new Date().toISOString().slice(0, 10);

const doc = (title: string, bodyMd: string, wire: string[] = []): IntentResult => ({
  document: { kind: "agency", title, bodyMd },
  speak: null,
  wire,
});

const USAGE = [
  "| COMMAND | EXAMPLE |",
  "|---|---|",
  "| New lead | `agency lead Acme Corp \\| found via reddit, wants chatbot` |",
  "| Lead won → client | `agency won acme` |",
  "| Lead lost | `agency lost acme` |",
  "| New project | `agency project Chatbot v1 \\| acme \\| 500` |",
  "| Project finished | `agency done chatbot` |",
  "| Payment received | `agency paid acme 250 first half` |",
  "| Lists | `agency leads` · `agency clients` · `agency projects` · `agency payments` |",
  "| Pipeline board | `agency` or the AGENCY BOARD button |",
].join("\n");

async function loadAll<T>(
  ctx: RunContext,
  col: string,
  schema: z.ZodType<T>,
): Promise<Array<T & { id: string }>> {
  const rows = await ctx.records.list(col);
  const out: Array<T & { id: string }> = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row.data);
    if (parsed.success) out.push({ ...(parsed.data as T), id: row.id });
  }
  return out;
}

function findByFrag<T extends { id: string; name: string }>(
  rows: T[],
  frag: string,
): { hit?: T; error?: string } {
  const f = frag.trim().toLowerCase();
  if (!f) return { error: "name required" };
  const hits = rows.filter((r) => r.name.toLowerCase().includes(f) || r.id.includes(slug(frag)));
  if (hits.length === 0) return { error: `no match for "${frag}"` };
  if (hits.length > 1)
    return { error: `"${frag}" matches: ${hits.map((h) => h.name).join(", ")} — be more specific` };
  return { hit: hits[0] };
}

async function refreshMetrics(ctx: RunContext): Promise<void> {
  const leads = await loadAll(ctx, "agency.leads", LeadZ);
  const projects = await loadAll(ctx, "agency.projects", ProjectZ);
  const payments = await loadAll(ctx, "agency.payments", PaymentZ);
  const revenue = payments.reduce((a, p) => a + p.amount, 0);
  await ctx.metrics.record(
    "agency.leads",
    "OPEN LEADS",
    leads.filter((l) => l.status === "open").length,
    "",
  );
  await ctx.metrics.record(
    "agency.projects",
    "ACTIVE PROJECTS",
    projects.filter((p) => p.status === "active").length,
    "",
  );
  await ctx.metrics.record("agency.revenue", "REVENUE", revenue, "$");
}

async function renderBoard(ctx: RunContext): Promise<string> {
  const leads = await loadAll(ctx, "agency.leads", LeadZ);
  const clients = await loadAll(ctx, "agency.clients", ClientZ);
  const projects = await loadAll(ctx, "agency.projects", ProjectZ);
  const payments = await loadAll(ctx, "agency.payments", PaymentZ);

  const open = leads.filter((l) => l.status === "open");
  const active = projects.filter((p) => p.status === "active");
  const revenue = payments.reduce((a, p) => a + p.amount, 0);
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const rev30 = payments.filter((p) => p.date >= cutoff).reduce((a, p) => a + p.amount, 0);

  const lines = [
    `**${open.length}** open leads · **${clients.length}** clients · **${active.length}** active projects · **$${revenue}** all-time (**$${rev30}** last 30d)`,
    "",
  ];
  if (leads.length + clients.length + projects.length === 0) {
    lines.push(
      "The rails are ready and empty. First move when the agency starts: `agency lead <name> | <how you found them>`.",
    );
    lines.push("");
    lines.push(USAGE);
    return lines.join("\n");
  }
  if (open.length > 0) {
    lines.push("## OPEN LEADS");
    for (const l of open)
      lines.push(`- **${l.name}** — ${l.note || "no note"} (since ${l.addedAt})`);
    lines.push("");
  }
  if (active.length > 0) {
    lines.push("## ACTIVE PROJECTS");
    for (const p of active)
      lines.push(`- **${p.name}** for ${p.client} — $${p.amount} (since ${p.addedAt})`);
    lines.push("");
  }
  if (payments.length > 0) {
    lines.push("## LAST PAYMENTS");
    for (const p of payments.slice(0, 5))
      lines.push(`- ${p.date} · **$${p.amount}** from ${p.client}${p.note ? ` — ${p.note}` : ""}`);
  }
  return lines.join("\n");
}

async function handleCommand(ctx: RunContext): Promise<IntentResult> {
  const line = (ctx.input ?? "").trim();
  const tokens = line.split(/\s+/).slice(1); // drop "agency"
  const sub = (tokens[0] ?? "board").toLowerCase();

  if (sub === "lead") {
    const parts = line
      .replace(/^\S+\s+lead\s+/i, "")
      .split("|")
      .map((s) => s.trim());
    const [name, note] = [parts[0] ?? "", parts[1] ?? ""];
    if (!name)
      return doc("Agency — bad command", `usage: \`agency lead <name> | <note>\`\n\n${USAGE}`);
    await ctx.records.put("agency.leads", slug(name), {
      name,
      note,
      status: "open",
      addedAt: today(),
      updatedAt: today(),
    });
    await refreshMetrics(ctx);
    return doc(`Lead: ${name}`, `Open lead **${name}** — ${note || "no note"}.`, [
      `AGENCY · lead ${name}`,
    ]);
  }

  if (sub === "won" || sub === "lost") {
    const leads = await loadAll(ctx, "agency.leads", LeadZ);
    const { hit, error } = findByFrag(
      leads.filter((l) => l.status === "open"),
      tokens.slice(1).join(" "),
    );
    if (!hit) return doc("Agency — lead not found", error ?? "no match");
    const { id, ...lead } = hit;
    await ctx.records.put("agency.leads", id, { ...lead, status: sub, updatedAt: today() });
    if (sub === "won") {
      await ctx.records.put("agency.clients", id, {
        name: hit.name,
        note: hit.note,
        addedAt: today(),
      });
    }
    await refreshMetrics(ctx);
    return doc(
      `Lead ${sub}: ${hit.name}`,
      sub === "won"
        ? `**${hit.name}** is now a client. Add work: \`agency project <name> | ${hit.name} | <amount>\``
        : `Marked **${hit.name}** lost.`,
      [`AGENCY · ${sub} ${hit.name}`],
    );
  }

  if (sub === "client") {
    const parts = line
      .replace(/^\S+\s+client\s+/i, "")
      .split("|")
      .map((s) => s.trim());
    const [name, note] = [parts[0] ?? "", parts[1] ?? ""];
    if (!name) return doc("Agency — bad command", "usage: `agency client <name> | <note>`");
    await ctx.records.put("agency.clients", slug(name), { name, note, addedAt: today() });
    return doc(`Client: ${name}`, `Client **${name}** added directly.`, [
      `AGENCY · client ${name}`,
    ]);
  }

  if (sub === "project") {
    const parts = line
      .replace(/^\S+\s+project\s+/i, "")
      .split("|")
      .map((s) => s.trim());
    const [name, clientFrag, amountRaw] = [parts[0] ?? "", parts[1] ?? "", parts[2] ?? "0"];
    if (!name || !clientFrag)
      return doc("Agency — bad command", "usage: `agency project <name> | <client> | <amount>`");
    const clients = await loadAll(ctx, "agency.clients", ClientZ);
    const { hit, error } = findByFrag(clients, clientFrag);
    if (!hit)
      return doc(
        "Agency — client not found",
        `${error} — add them first: \`agency client ${clientFrag}\``,
      );
    const amount = Number(amountRaw.replace(/^\$/, "")) || 0;
    await ctx.records.put("agency.projects", slug(name), {
      name,
      client: hit.name,
      amount,
      status: "active",
      addedAt: today(),
      updatedAt: today(),
    });
    await refreshMetrics(ctx);
    return doc(`Project: ${name}`, `**${name}** for ${hit.name} at **$${amount}** — active.`, [
      `AGENCY · project ${name} ($${amount})`,
    ]);
  }

  if (sub === "done") {
    const projects = await loadAll(ctx, "agency.projects", ProjectZ);
    const { hit, error } = findByFrag(
      projects.filter((p) => p.status === "active"),
      tokens.slice(1).join(" "),
    );
    if (!hit) return doc("Agency — project not found", error ?? "no match");
    const { id, ...project } = hit;
    await ctx.records.put("agency.projects", id, {
      ...project,
      status: "done",
      updatedAt: today(),
    });
    await refreshMetrics(ctx);
    return doc(
      `Project done: ${hit.name}`,
      `**${hit.name}** finished. Log the money when it lands: \`agency paid ${hit.client} ${hit.amount}\``,
      [`AGENCY · done ${hit.name}`],
    );
  }

  if (sub === "paid") {
    const clientFrag = tokens[1] ?? "";
    const amount = Number((tokens[2] ?? "").replace(/^\$/, ""));
    const note = tokens.slice(3).join(" ");
    if (!clientFrag || !Number.isFinite(amount) || amount <= 0)
      return doc("Agency — bad command", "usage: `agency paid <client> <amount> [note]`");
    const clients = await loadAll(ctx, "agency.clients", ClientZ);
    const { hit, error } = findByFrag(clients, clientFrag);
    if (!hit) return doc("Agency — client not found", error ?? "no match");
    await ctx.records.put("agency.payments", `${Date.now()}`, {
      client: hit.name,
      amount,
      note,
      date: today(),
    });
    await refreshMetrics(ctx);
    return doc(
      `Payment: $${amount} from ${hit.name}`,
      `Logged **$${amount}**${note ? ` — ${note}` : ""}.`,
      [`AGENCY · +$${amount} ${hit.name}`],
    );
  }

  if (["leads", "clients", "projects", "payments"].includes(sub)) {
    if (sub === "leads") {
      const rows = await loadAll(ctx, "agency.leads", LeadZ);
      return doc(
        "Agency — leads",
        rows.length > 0
          ? rows
              .map((l) => `- [${l.status}] **${l.name}** — ${l.note || "no note"} (${l.updatedAt})`)
              .join("\n")
          : "No leads yet.",
      );
    }
    if (sub === "clients") {
      const rows = await loadAll(ctx, "agency.clients", ClientZ);
      return doc(
        "Agency — clients",
        rows.length > 0
          ? rows
              .map((c) => `- **${c.name}** — ${c.note || "no note"} (since ${c.addedAt})`)
              .join("\n")
          : "No clients yet.",
      );
    }
    if (sub === "projects") {
      const rows = await loadAll(ctx, "agency.projects", ProjectZ);
      return doc(
        "Agency — projects",
        rows.length > 0
          ? rows
              .map((p) => `- [${p.status}] **${p.name}** for ${p.client} — $${p.amount}`)
              .join("\n")
          : "No projects yet.",
      );
    }
    const rows = await loadAll(ctx, "agency.payments", PaymentZ);
    const total = rows.reduce((a, p) => a + p.amount, 0);
    return doc(
      "Agency — payments",
      rows.length > 0
        ? [
            ...rows.map(
              (p) =>
                `- ${p.date} · **$${p.amount}** from ${p.client}${p.note ? ` — ${p.note}` : ""}`,
            ),
            "",
            `**Total: $${total}**`,
          ].join("\n")
        : "No payments yet.",
    );
  }

  if (sub === "board") return doc(`Agency Board — ${today()}`, await renderBoard(ctx));

  return doc("Agency — commands", USAGE);
}

export function createAgencyPlugin(): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.agency",
      name: "Agency",
      version: "0.1.0",
      description: "Freelance / agency pipeline: leads → clients → projects → payments.",
      capabilities: ["records", "fs.documents", "metrics.read", "metrics.write"],
      optional: true,
    },
    tools: [],
    scheduledJobs: [],
    commands: [
      {
        prefix: "agency",
        intentKey: INTENT.AGENCY_CMD,
        usage: "agency lead <name> | <note>",
        description: "Agency pipeline (lead/won/project/paid/lists)",
      },
    ],
    intents: [
      {
        key: INTENT.AGENCY_BOARD,
        label: "AGENCY BOARD",
        agent: AGENT.SYSTEM,
        description:
          "Pipeline snapshot: open leads, active projects, revenue — straight from the database.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          try {
            await refreshMetrics(ctx);
            return ok(doc(`Agency Board — ${today()}`, await renderBoard(ctx), ["AGENCY · board"]));
          } catch (e) {
            return err("AGENCY_BOARD", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        key: INTENT.AGENCY_CMD,
        label: "AGENCY CMD",
        agent: AGENT.SYSTEM,
        description: "Typed agency commands — parsed by code, no AI.",
        scheduleCron: null,
        requiresIntegration: null,
        hidden: true,
        async handler(ctx) {
          try {
            return ok(await handleCommand(ctx));
          } catch (e) {
            return err("AGENCY_CMD", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ],
  });
}
