import type { DbHandle } from "@nexus/db";
import { integrations as integrationsTable } from "@nexus/db";
import { eq } from "drizzle-orm";
import type { EventBus } from "../bus";
import type { SecretService } from "../services";
import { GoogleIntegration } from "./google";
import { NotionIntegration } from "./notion";

export { GoogleIntegration } from "./google";
export { NotionIntegration } from "./notion";

/**
 * Integration hub: owns provider instances, persists non-secret status in
 * the DB, and broadcasts `link.status`. All providers are OPTIONAL — Nexus
 * is fully functional with everything disconnected.
 */
export class IntegrationHub {
  readonly google: GoogleIntegration;
  readonly notion: NotionIntegration;

  constructor(
    private readonly handle: DbHandle,
    private readonly bus: EventBus,
    secrets: SecretService,
  ) {
    this.google = new GoogleIntegration(secrets);
    this.notion = new NotionIntegration(secrets);
  }

  setStatus(
    provider: string,
    status: "disconnected" | "connected" | "error" | "syncing",
    accountLabel: string | null = null,
  ): void {
    const row = {
      provider,
      status,
      accountLabel,
      lastSync: status === "connected" ? new Date().toISOString() : null,
      configJson: "{}",
    };
    this.handle.db
      .insert(integrationsTable)
      .values(row)
      .onConflictDoUpdate({ target: integrationsTable.provider, set: row })
      .run();
    this.broadcast();
  }

  status(provider: string): string {
    const row = this.handle.db
      .select()
      .from(integrationsTable)
      .where(eq(integrationsTable.provider, provider))
      .all()[0];
    return row?.status ?? "disconnected";
  }

  broadcast(): void {
    const rows = this.handle.db.select().from(integrationsTable).all();
    this.bus.emit("link.status", {
      integrations: rows.map((i) => ({
        provider: i.provider,
        status: i.status as "disconnected" | "connected" | "error" | "syncing",
        accountLabel: i.accountLabel,
        lastSync: i.lastSync,
      })),
    });
  }
}
