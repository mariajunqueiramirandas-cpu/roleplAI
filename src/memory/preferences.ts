import type { DB } from "../db/db.ts";

/** The player's tone, content limits and play style. Not branch-scoped: they belong to the player. */
export function setPreference(db: DB, key: string, value: string) {
  db.query("INSERT INTO preferences(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function preferences(db: DB): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.query("SELECT key, value FROM preferences ORDER BY key").all() as { key: string; value: string }[]) out[r.key] = r.value;
  return out;
}

export function preferencesText(db: DB): string {
  const p = preferences(db);
  const keys = Object.keys(p);
  return keys.length ? keys.map((k) => `- ${k}: ${p[k]}`).join("\n") : "";
}
