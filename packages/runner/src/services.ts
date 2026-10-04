import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MetricDto, type Result, err, ok, tryAsync } from "@nexus/core";
import type { DbHandle } from "@nexus/db";
import {
  audit,
  cards,
  directives,
  documents,
  metrics,
  netCache,
  pluginRecords,
  wireItems,
} from "@nexus/db";
import type {
  DirectivesApi,
  DocumentsApi,
  MetricsApi,
  NetApi,
  RecordRow,
  RecordsApi,
  SecretsApi,
  WireApi,
} from "@nexus/plugin-sdk";
import { and, desc, eq } from "drizzle-orm";
import type { EventBus } from "./bus";

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Documents — the vault (markdown on disk + DB trail)                 */
/* ------------------------------------------------------------------ */

export class DocumentService implements DocumentsApi {
  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
    private readonly vaultDir: string,
  ) {
    mkdirSync(vaultDir, { recursive: true });
  }

  async write(kind: string, title: string, bodyMd: string, runId: string | null = null) {
    const id = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const path = join(this.vaultDir, `${date}-${slug || "document"}-${id.slice(0, 8)}.md`);
    writeFileSync(path, `# ${title}\n\n${bodyMd}\n`, "utf8");
    this.handle.db
      .insert(documents)
      .values({ id, runId, kind, title, path, bodyMd, createdAt: now() })
      .run();
    this.bus.emit("document.created", { id, runId, kind, title, path, createdAt: now() });
    return { id, path };
  }

  async recent(limit = 12) {
    return this.handle.db
      .select()
      .from(documents)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .all()
      .map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        bodyMd: d.bodyMd,
        createdAt: d.createdAt,
      }));
  }

  list(limit = 40) {
    return this.handle.db
      .select({
        id: documents.id,
        runId: documents.runId,
        kind: documents.kind,
        title: documents.title,
        path: documents.path,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .all();
  }
}

/* ------------------------------------------------------------------ */
/* Result cards on the stage                                           */
/* ------------------------------------------------------------------ */

export class CardService {
  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
  ) {}

  create(documentId: string | null, title: string, kind: string, bodyMd: string) {
    const id = randomUUID();
    // Scatter new cards around the nebula, avoiding dead center.
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.28 + Math.random() * 0.12;
    const x = Math.min(0.9, Math.max(0.1, 0.5 + Math.cos(angle) * radius));
    const y = Math.min(0.85, Math.max(0.12, 0.5 + Math.sin(angle) * radius * 0.7));
    const row = { id, documentId, title, kind, bodyMd, x, y, createdAt: now() };
    this.handle.db.insert(cards).values(row).run();
    this.bus.emit("card.created", row);
    return id;
  }

  move(cardId: string, x: number, y: number): void {
    this.handle.db.update(cards).set({ x, y }).where(eq(cards.id, cardId)).run();
    const row = this.handle.db.select().from(cards).where(eq(cards.id, cardId)).all()[0];
    if (row) this.bus.emit("card.updated", row);
  }

  clearAll(): number {
    const count = this.handle.db.select().from(cards).all().length;
    this.handle.db.delete(cards).run();
    this.bus.emit("cards.cleared", { count });
    return count;
  }

  list() {
    return this.handle.db.select().from(cards).orderBy(cards.createdAt).all();
  }
}

/* ------------------------------------------------------------------ */
/* Metrics — SYSTEM VITALS                                             */
/* ------------------------------------------------------------------ */

const SERIES_MAX = 32;

export class MetricService implements MetricsApi {
  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
  ) {}

  async all(): Promise<MetricDto[]> {
    return this.handle.db
      .select()
      .from(metrics)
      .all()
      .map((m) => ({
        key: m.key,
        label: m.label,
        value: m.value,
        unit: m.unit,
        delta: m.delta,
        deltaUnit: m.deltaUnit,
        series: JSON.parse(m.seriesJson) as number[],
        updatedAt: m.updatedAt,
      }));
  }

  async record(key: string, label: string, value: number, unit = ""): Promise<void> {
    const existing = this.handle.db.select().from(metrics).where(eq(metrics.key, key)).all()[0];
    const series: number[] = existing ? (JSON.parse(existing.seriesJson) as number[]) : [];
    const prev = series.length > 0 ? (series[series.length - 1] ?? value) : value;
    series.push(value);
    while (series.length > SERIES_MAX) series.shift();
    const row = {
      key,
      label,
      value,
      unit,
      delta: value - prev,
      deltaUnit: existing?.deltaUnit ?? null,
      seriesJson: JSON.stringify(series),
      updatedAt: now(),
    };
    this.handle.db
      .insert(metrics)
      .values(row)
      .onConflictDoUpdate({ target: metrics.key, set: row })
      .run();
    await this.broadcast();
  }

  async broadcast(): Promise<void> {
    this.bus.emit("vitals.update", { metrics: await this.all(), primary: await this.primary() });
  }

  /** The big center number: highest-priority metric flagged as primary. */
  async primary() {
    const rows = await this.all();
    const primary = rows.find((m) => m.key === "primary.value");
    if (!primary) return null;
    const velocity = rows.find((m) => m.key === "primary.velocity");
    const sublines: string[] = [];
    if (velocity) sublines.push(`VELOCITY ${velocity.value.toLocaleString("en-US")}/DAY`);
    sublines.push(`UPDATED ${primary.updatedAt.slice(11, 16)}Z`);
    return {
      label: primary.label.toUpperCase(),
      value: primary.value,
      unit: primary.unit.toUpperCase(),
      sublines,
    };
  }
}

/* ------------------------------------------------------------------ */
/* AI Wire feed                                                        */
/* ------------------------------------------------------------------ */

export class WireService implements WireApi {
  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
  ) {}

  async append(channel: string, text: string): Promise<void> {
    const item = { id: randomUUID(), channel, text, createdAt: now() };
    this.handle.db.insert(wireItems).values(item).run();
    this.bus.emit("wire.append", item);
  }

  recent(limit = 30) {
    return this.handle.db
      .select()
      .from(wireItems)
      .orderBy(desc(wireItems.createdAt))
      .limit(limit)
      .all()
      .reverse();
  }
}

/* ------------------------------------------------------------------ */
/* Directives                                                          */
/* ------------------------------------------------------------------ */

export class DirectiveService implements DirectivesApi {
  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
  ) {}

  async list(includeDone = false) {
    const rows = this.handle.db
      .select()
      .from(directives)
      .orderBy(desc(directives.priority), directives.createdAt)
      .all();
    return rows
      .filter((d) => includeDone || !d.done)
      .map((d) => ({ id: d.id, text: d.text, priority: d.priority, done: d.done }));
  }

  async add(text: string, priority = 0): Promise<string> {
    const id = randomUUID();
    this.handle.db
      .insert(directives)
      .values({ id, text, priority, done: false, createdAt: now() })
      .run();
    await this.broadcast();
    return id;
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.handle.db.update(directives).set({ done }).where(eq(directives.id, id)).run();
    await this.broadcast();
  }

  async broadcast(): Promise<void> {
    const list = this.handle.db
      .select()
      .from(directives)
      .orderBy(desc(directives.priority), directives.createdAt)
      .all()
      .map((d) => ({
        id: d.id,
        text: d.text,
        priority: d.priority,
        done: d.done,
        createdAt: d.createdAt,
      }));
    this.bus.emit("directives.update", { directives: list });
  }
}

/* ------------------------------------------------------------------ */
/* Net — cached fetch (offline-first, no key required)                 */
/* ------------------------------------------------------------------ */

export class NetService implements NetApi {
  /**
   * Passive connectivity tracking — updated only by real, user-configured
   * fetches (Nexus never probes the network unsolicited).
   */
  lastKnownOffline = false;

  constructor(private readonly handle: DbHandle) {}

  async fetchCached(
    key: string,
    url: string,
    ttlSec: number,
    init?: RequestInit,
  ): Promise<Result<{ body: string; fromCache: boolean }>> {
    const cached = this.handle.db.select().from(netCache).where(eq(netCache.key, key)).all()[0];
    const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttlSec * 1000;
    if (cached && fresh) {
      return ok({ body: JSON.parse(cached.valueJson) as string, fromCache: true });
    }
    const live = await tryAsync("NET_FETCH", async () => {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.text();
    });
    this.lastKnownOffline = !live.ok;
    if (live.ok) {
      const provider = new URL(url).hostname;
      const row = { key, provider, valueJson: JSON.stringify(live.value), fetchedAt: now() };
      this.handle.db
        .insert(netCache)
        .values(row)
        .onConflictDoUpdate({ target: netCache.key, set: row })
        .run();
      return ok({ body: live.value, fromCache: false });
    }
    // Offline → serve stale cache if we have one.
    if (cached) return ok({ body: JSON.parse(cached.valueJson) as string, fromCache: true });
    return err("NET_OFFLINE", `offline and no cache for ${key}`);
  }
}

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/*                                                                     */
/* Packaged mode: the Tauri Shell owns the Stronghold vault and pushes */
/* unlocked secrets into this in-memory store over the authed loopback */
/* API at boot. Dev mode: AES-256-GCM file keyed by a local keyfile in */
/* the user-only data dir (never the DB, never logged, never sent to   */
/* the UI).                                                            */
/* ------------------------------------------------------------------ */

export class SecretService implements SecretsApi {
  private mem = new Map<string, string>();
  private readonly file: string;
  private readonly keyFile: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "secrets.enc");
    this.keyFile = join(dataDir, "secrets.key");
    this.loadDevFile();
  }

  async get(key: string): Promise<string | null> {
    return this.mem.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.mem.set(key, value);
    this.persistDevFile();
  }

  async delete(key: string): Promise<void> {
    this.mem.delete(key);
    this.persistDevFile();
  }

  /** Shell pushes Stronghold-unlocked secrets here at boot (in-memory only). */
  hydrate(entries: Record<string, string>): void {
    for (const [k, v] of Object.entries(entries)) this.mem.set(k, v);
  }

  private devKey(): Buffer {
    if (!existsSync(this.keyFile)) {
      writeFileSync(this.keyFile, randomBytes(32));
    }
    return readFileSync(this.keyFile);
  }

  private loadDevFile(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file);
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.devKey(), iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      this.mem = new Map(Object.entries(JSON.parse(json) as Record<string, string>));
    } catch (e) {
      console.error("[secrets] failed to load dev secret file:", e);
    }
  }

  private persistDevFile(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.devKey(), iv);
    const json = JSON.stringify(Object.fromEntries(this.mem));
    const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    writeFileSync(this.file, Buffer.concat([iv, cipher.getAuthTag(), data]));
  }
}

/* ------------------------------------------------------------------ */
/* Records — structured plugin storage (life tracking source of truth) */
/* ------------------------------------------------------------------ */

export class RecordsService implements RecordsApi {
  constructor(private readonly handle: DbHandle) {}

  async put(collection: string, id: string, data: object): Promise<void> {
    const ts = now();
    const existing = this.handle.db
      .select({ createdAt: pluginRecords.createdAt })
      .from(pluginRecords)
      .where(and(eq(pluginRecords.collection, collection), eq(pluginRecords.recordId, id)))
      .all()[0];
    const row = {
      collection,
      recordId: id,
      dataJson: JSON.stringify(data),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.handle.db
      .insert(pluginRecords)
      .values(row)
      .onConflictDoUpdate({ target: [pluginRecords.collection, pluginRecords.recordId], set: row })
      .run();
  }

  async get(collection: string, id: string): Promise<RecordRow | null> {
    const row = this.handle.db
      .select()
      .from(pluginRecords)
      .where(and(eq(pluginRecords.collection, collection), eq(pluginRecords.recordId, id)))
      .all()[0];
    return row ? this.toRow(row) : null;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const before = await this.count(collection);
    this.handle.db
      .delete(pluginRecords)
      .where(and(eq(pluginRecords.collection, collection), eq(pluginRecords.recordId, id)))
      .run();
    return (await this.count(collection)) < before;
  }

  async list(collection: string, opts?: { limit?: number; offset?: number }): Promise<RecordRow[]> {
    return this.handle.db
      .select()
      .from(pluginRecords)
      .where(eq(pluginRecords.collection, collection))
      .orderBy(desc(pluginRecords.updatedAt))
      .limit(opts?.limit ?? 1000)
      .offset(opts?.offset ?? 0)
      .all()
      .map((r) => this.toRow(r));
  }

  async count(collection: string): Promise<number> {
    return this.handle.db
      .select({ recordId: pluginRecords.recordId })
      .from(pluginRecords)
      .where(eq(pluginRecords.collection, collection))
      .all().length;
  }

  private toRow(r: typeof pluginRecords.$inferSelect): RecordRow {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.dataJson) as Record<string, unknown>;
    } catch {
      /* corrupt row → surfaces as empty data rather than crashing the run */
    }
    return { id: r.recordId, data, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export class AuditService {
  constructor(private readonly handle: DbHandle) {}

  log(actor: string, action: string, target = "", meta: Record<string, unknown> = {}): void {
    this.handle.db
      .insert(audit)
      .values({
        id: randomUUID(),
        actor,
        action,
        target,
        metaJson: JSON.stringify(meta),
        createdAt: now(),
      })
      .run();
  }
}
