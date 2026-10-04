import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "./migrate";
import * as schema from "./schema";
import { type VectorIndex, createVectorIndex } from "./vec";

export type NexusDb = BunSQLiteDatabase<typeof schema>;

export interface DbHandle {
  db: NexusDb;
  sqlite: Database;
  vec: VectorIndex;
  close(): void;
}

/**
 * Open (and migrate) the single Nexus database. The Runner is the sole
 * writer in the whole system; the UI never touches this file.
 */
export function openDb(path: string): DbHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  migrate(sqlite);
  const vec = createVectorIndex(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    vec,
    close: () => sqlite.close(),
  };
}
