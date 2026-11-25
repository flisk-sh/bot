// Where the bot keeps its sessions: the BotStore interface and the Cloudflare D1 store (the Worker). The folder of JSON
// checkpoints (the Flisk "files" durability) is in file-store.ts, so the Worker bundle never imports node:fs.
import type { Checkpoint } from './jobs';

type Maybe<T> = T | Promise<T>;

export interface SessionSummary {
  sessionId: string;
  lastActivity: string;
  checkpointBytes: number;
}

export interface BotStore {
  ready(): Maybe<boolean>;
  load(id: string): Maybe<Checkpoint>;
  save(c: Checkpoint): Maybe<void>;
  delete(id: string): Maybe<void>;
  list(): Maybe<SessionSummary[]>;
  /** The newest sessions with their checkpoints, for the web view, in as few reads as the store can manage. */
  recent(limit: number): Maybe<(SessionSummary & { c: Checkpoint })[]>;
  /** Removes chat sessions quiet since `before` (ms). job-<id> sessions are the bot's record and stay. Returns how many went. */
  sweep(before: number, busy: (id: string) => boolean): Maybe<number>;
  readKey(): Maybe<string | null>;
  writeKey(k: string): Maybe<void>;
  /** Today's use of the model and the computers (one small JSON text), so the free allowance has a daily cap. */
  readUsage(): Maybe<string | null>;
  writeUsage(v: string): Maybe<void>;
}

// The subset of Cloudflare's D1 binding that the bot uses.
export interface D1Like {
  prepare(sql: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes?: number } }> } };
}

export const D1_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated)',
  'CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

export function d1Store(db: D1Like): BotStore {
  const encoder = new TextEncoder();
  const q = (sql: string, ...a: unknown[]) => db.prepare(sql).bind(...a);
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    async ready() {
      try {
        await q('SELECT 1 AS ok').first();
        return true;
      } catch {
        return false;
      }
    },
    async load(sessionId) {
      const row = await q('SELECT data FROM sessions WHERE id = ?', sessionId).first<{ data: string }>();
      return row ? JSON.parse(row.data) : { sessionId, messages: [] };
    },
    async save(c) {
      const data = JSON.stringify(c);
      await q('INSERT INTO sessions (id, updated, bytes, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, bytes = excluded.bytes, data = excluded.data', c.sessionId, Date.now(), encoder.encode(data).byteLength, data).run();
    },
    async delete(sessionId) {
      await q('DELETE FROM sessions WHERE id = ?', sessionId).run();
    },
    async list() {
      const { results } = await q('SELECT id, updated, bytes FROM sessions ORDER BY updated DESC LIMIT 1000').all<{ id: string; updated: number; bytes: number }>();
      return results.map((r) => ({ sessionId: r.id, lastActivity: iso(r.updated), checkpointBytes: r.bytes }));
    },
    async recent(limit) {
      const { results } = await q('SELECT id, updated, bytes, data FROM sessions ORDER BY updated DESC LIMIT ?', limit).all<{ id: string; updated: number; bytes: number; data: string }>();
      return results.map((r) => ({ sessionId: r.id, lastActivity: iso(r.updated), checkpointBytes: r.bytes, c: JSON.parse(r.data) as Checkpoint }));
    },
    async sweep(before, busy) {
      const { results } = await q("SELECT id FROM sessions WHERE updated < ? AND id NOT LIKE 'job-%'", before).all<{ id: string }>();
      let n = 0;
      for (const { id } of results) {
        if (busy(id)) continue;
        await q('DELETE FROM sessions WHERE id = ? AND updated < ?', id, before).run();
        n++;
      }
      return n;
    },
    async readKey() {
      return (await q("SELECT v FROM state WHERE k = 'board_key'").first<{ v: string }>())?.v ?? null;
    },
    async writeKey(k) {
      await q("INSERT INTO state (k, v) VALUES ('board_key', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k).run();
    },
    async readUsage() {
      return (await q("SELECT v FROM state WHERE k = 'usage'").first<{ v: string }>())?.v ?? null;
    },
    async writeUsage(v) {
      await q("INSERT INTO state (k, v) VALUES ('usage', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", v).run();
    },
  };
}
