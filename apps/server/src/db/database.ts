import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";

export type Row = Record<string, SQLInputValue>;

/**
 * Thin wrapper around node:sqlite with nested transactions (savepoints) and
 * helpers for JSON columns. All access is synchronous, which the workflow
 * engine relies on for atomic state transitions.
 */
export class Database {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
  }

  migrate(): string[] {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));
    const ran: string[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", migration.version, migration.name, Date.now());
      });
      ran.push(`${migration.version}_${migration.name}`);
    }
    return ran;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
