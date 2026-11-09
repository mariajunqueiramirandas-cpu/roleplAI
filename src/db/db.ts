import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "node:fs";
import { migrations } from "./schema.ts";

let customSqliteSet = false;

/**
 * Apple's system SQLite blocks extensions. Point Bun at Homebrew's SQLite before
 * the first Database is opened. ROLEPLAI_SQLITE overrides the search.
 */
function ensureExtensionCapableSqlite() {
  if (customSqliteSet || process.platform !== "darwin") return;
  const candidates = [
    process.env.ROLEPLAI_SQLITE,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "macOS: install SQLite with Homebrew (brew install sqlite) or set ROLEPLAI_SQLITE to a libsqlite3.dylib that allows extensions.",
    );
  }
  Database.setCustomSQLite(found);
  customSqliteSet = true;
}

export type DB = Database;

export function openDb(path: string, dims = 1024): DB {
  ensureExtensionCapableSqlite();
  const db = new Database(path, { create: true });
  sqliteVec.load(db);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db, dims);
  return db;
}

function migrate(db: DB, dims: number) {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const all = migrations(dims);
  for (let v = version; v < all.length; v++) {
    db.transaction(() => {
      db.exec(all[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  if (version === 0) setMeta(db, "dims", String(dims));
  const stored = Number(getMeta(db, "dims") ?? dims);
  if (stored !== dims) {
    throw new Error(`Campaign stores ${stored}-dimension vectors but config asks for ${dims}.`);
  }
}

export function getMeta(db: DB, key: string): string | null {
  const r = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string) {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn)();
}
