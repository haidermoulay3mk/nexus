import type { Database } from "bun:sqlite";
import { type Result, err, ok } from "@nexus/core";

/**
 * Vector search over memory embeddings.
 *
 * Primary path: the `sqlite-vec` loadable extension with a `vec0` virtual
 * table (`memory_vec_idx`) for fast KNN. If the extension cannot load on
 * this platform, we degrade to brute-force cosine over `memory_vectors` —
 * slower but identical results at personal scale, preserving the 100%-free
 * offline guarantee on every machine.
 */

export interface VecSearchHit {
  memoryId: string;
  distance: number; // cosine distance (lower = closer)
}

export interface VectorIndex {
  readonly backend: "sqlite-vec" | "js-fallback";
  upsert(memoryId: string, embedding: Float32Array): void;
  remove(memoryId: string): void;
  search(query: Float32Array, k: number): VecSearchHit[];
}

export function encodeEmbedding(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tryLoadSqliteVec(sqlite: Database): Result<null> {
  try {
    // sqlite-vec ships per-platform loadable binaries in its npm package.
    // Dynamic require keeps boot resilient when the platform binary is absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
    sqlite.loadExtension(sqliteVec.getLoadablePath());
    sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec_idx
         USING vec0(memory_id TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine);`,
    );
    return ok(null);
  } catch (e) {
    return err("VEC_EXT_LOAD", "sqlite-vec extension unavailable, using JS fallback", e);
  }
}

class SqliteVecIndex implements VectorIndex {
  readonly backend = "sqlite-vec" as const;
  constructor(private readonly sqlite: Database) {}

  upsert(memoryId: string, embedding: Float32Array): void {
    this.sqlite.query("DELETE FROM memory_vec_idx WHERE memory_id = ?").run(memoryId);
    this.sqlite
      .query("INSERT INTO memory_vec_idx(memory_id, embedding) VALUES (?, ?)")
      .run(memoryId, new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  }

  remove(memoryId: string): void {
    this.sqlite.query("DELETE FROM memory_vec_idx WHERE memory_id = ?").run(memoryId);
  }

  search(query: Float32Array, k: number): VecSearchHit[] {
    const rows = this.sqlite
      .query(
        `SELECT memory_id AS memoryId, distance
           FROM memory_vec_idx
          WHERE embedding MATCH ?
            AND k = ?
          ORDER BY distance`,
      )
      .all(new Uint8Array(query.buffer, query.byteOffset, query.byteLength), k) as VecSearchHit[];
    return rows;
  }
}

class JsFallbackIndex implements VectorIndex {
  readonly backend = "js-fallback" as const;
  constructor(private readonly sqlite: Database) {}

  upsert(_memoryId: string, _embedding: Float32Array): void {
    // Durable storage happens in memory_vectors (written by the memory
    // service); the fallback searches that table directly, so no-op here.
  }

  remove(_memoryId: string): void {
    // Same: memory_vectors row removal is handled by the memory service.
  }

  search(query: Float32Array, k: number): VecSearchHit[] {
    const rows = this.sqlite
      .query("SELECT memory_id AS memoryId, embedding FROM memory_vectors")
      .all() as Array<{ memoryId: string; embedding: string }>;
    const hits: VecSearchHit[] = rows.map((r) => ({
      memoryId: r.memoryId,
      distance: cosineDistance(query, decodeEmbedding(r.embedding)),
    }));
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, k);
  }
}

export function createVectorIndex(sqlite: Database): VectorIndex {
  const loaded = tryLoadSqliteVec(sqlite);
  if (loaded.ok) return new SqliteVecIndex(sqlite);
  console.warn(`[db] ${loaded.error.message}`);
  return new JsFallbackIndex(sqlite);
}
