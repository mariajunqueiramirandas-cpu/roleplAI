import type { DB } from "../db/db.ts";
import { json, formatTime, GOLD, PLAYER } from "../util.ts";
import { getWorld } from "./projection.ts";
import type { Effect } from "./tools.ts";

export interface EntityRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  location: string | null;
  alive: number;
  stub: number;
  profile: string;
  merged_into: string | null;
  created_turn: number;
}
export interface StatRow {
  entity: string;
  name: string;
  toward: string;
  value: number;
  max: number | null;
  category: string;
}
export interface StatusRow {
  id: string;
  entity: string;
  label: string;
  effects: string;
  expires_at: number | null;
  created_at: number;
  last_tick: number;
}
export interface ThreadRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  summary: string;
  entities: string;
  hidden: number;
  opened_turn: number;
  updated_turn: number;
  updated_time: number;
}

export function gameTime(db: DB): number {
  return Number(getWorld(db, "game_time") ?? 0);
}
export function currentScene(db: DB): number {
  return Number(getWorld(db, "scene") ?? 0);
}

/** Follow merges to the surviving entity. */
export function canonical(db: DB, id: string): string {
  let cur = id;
  for (let i = 0; i < 10; i++) {
    const r = db.query("SELECT merged_into FROM p_entities WHERE id = ?").get(cur) as { merged_into: string | null } | null;
    if (!r?.merged_into) return cur;
    cur = r.merged_into;
  }
  return cur;
}

/** All ids that now mean this entity (itself plus anything merged into it). */
export function idsOf(db: DB, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const r of db.query("SELECT id FROM p_entities WHERE merged_into = ?").all(out[i]) as { id: string }[]) out.push(r.id);
  }
  return out;
}

export function getEntity(db: DB, id: string): EntityRow | null {
  return db.query("SELECT * FROM p_entities WHERE id = ?").get(canonical(db, id)) as EntityRow | null;
}

export function getStat(db: DB, entity: string, stat: string, toward = ""): StatRow | null {
  return db.query("SELECT * FROM p_stats WHERE entity = ? AND name = ? AND toward = ?").get(entity, stat, toward) as StatRow | null;
}

export function statsOf(db: DB, entity: string): StatRow[] {
  return db.query("SELECT * FROM p_stats WHERE entity = ? ORDER BY category, name, toward").all(entity) as StatRow[];
}

export function statusesOf(db: DB, entity: string): StatusRow[] {
  return db.query("SELECT * FROM p_statuses WHERE entity = ? ORDER BY created_at, id").all(entity) as StatusRow[];
}

export function traitsOf(db: DB, entity: string): { label: string; bonus: number }[] {
  return db.query("SELECT label, bonus FROM p_traits WHERE entity = ? ORDER BY label").all(entity) as { label: string; bonus: number }[];
}

export function holdingsOf(db: DB, holder: string): { item: string; qty: number }[] {
  return db.query("SELECT item, qty FROM p_holdings WHERE holder = ? ORDER BY item").all(holder) as { item: string; qty: number }[];
}

export function holding(db: DB, holder: string, item: string): number {
  const r = db.query("SELECT qty FROM p_holdings WHERE holder = ? AND item = ?").get(holder, item) as { qty: number } | null;
  return r?.qty ?? 0;
}

export function effectsOf(db: DB, entity: string): Effect[] {
  return statusesOf(db, entity).flatMap((s) => json<Effect[]>(s.effects, []));
}

/** Max after status max-modifiers. */
export function effectiveMax(db: DB, entity: string, stat: string, toward = ""): number | null {
  const s = getStat(db, entity, stat, toward);
  if (!s || s.max == null) return s?.max ?? null;
  const mod = effectsOf(db, entity)
    .filter((e): e is Extract<Effect, { type: "max_modifier" }> => e.type === "max_modifier" && e.stat === stat)
    .reduce((a, e) => a + e.amount, 0);
  return Math.max(0, s.max + mod);
}

export function level(db: DB, entity: string): number {
  return getStat(db, entity, "level")?.value ?? 1;
}

export function entitiesAt(db: DB, location: string): EntityRow[] {
  return db
    .query("SELECT * FROM p_entities WHERE location = ? AND merged_into IS NULL ORDER BY kind, name")
    .all(location) as EntityRow[];
}

export function activeThreads(db: DB): ThreadRow[] {
  return db
    .query("SELECT * FROM p_threads WHERE status IN ('open','progressing') ORDER BY updated_turn DESC")
    .all() as ThreadRow[];
}

export function nameOf(db: DB, id: string): string {
  if (id === GOLD) return "gold";
  return getEntity(db, id)?.name ?? id;
}

function fmtNum(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** One-line authoritative hard state, e.g. "HP 23/40 · Mana 5/20 · Gold 31 · ..." */
export function hardStateLine(db: DB, entity: string = PLAYER): string {
  const e = getEntity(db, entity);
  if (!e) return `${entity}: unknown`;
  const parts: string[] = [];
  const hp = getStat(db, entity, "hp");
  if (hp) parts.push(`HP ${fmtNum(hp.value)}/${fmtNum(effectiveMax(db, entity, "hp") ?? hp.value)}`);
  const mana = getStat(db, entity, "mana");
  if (mana) parts.push(`Mana ${fmtNum(mana.value)}/${fmtNum(effectiveMax(db, entity, "mana") ?? mana.value)}`);
  const lvl = getStat(db, entity, "level");
  const xp = getStat(db, entity, "xp");
  if (lvl) parts.push(`Level ${lvl.value}${xp ? ` (XP ${xp.value})` : ""}`);
  const gold = holding(db, entity, GOLD);
  if (entity === PLAYER || gold) parts.push(`Gold ${gold}`);
  if (!e.alive) parts.push("DEAD");
  if (e.location) parts.push(`at ${nameOf(db, e.location)}`);
  return parts.join(" · ");
}

export function describeStateBlock(db: DB, entity: string = PLAYER): string {
  const e = getEntity(db, entity);
  if (!e) return "";
  const lines = [`${e.name} [${e.id}] — ${hardStateLine(db, entity)}`];
  const attrs = statsOf(db, entity).filter((s) => s.category === "attribute");
  if (attrs.length) lines.push(`Attributes: ${attrs.map((a) => `${a.name} ${a.value >= 0 ? "+" : ""}${a.value}`).join(", ")}`);
  const traits = traitsOf(db, entity);
  if (traits.length) lines.push(`Traits: ${traits.map((t) => `${t.label} ${t.bonus >= 0 ? "+" : ""}${t.bonus}`).join(", ")}`);
  const custom = statsOf(db, entity).filter((s) => s.category === "custom");
  if (custom.length)
    lines.push(
      `Other stats: ${custom
        .map((s) => `${s.name}${s.toward ? ` toward ${nameOf(db, s.toward)}` : ""} ${fmtNum(s.value)}${s.max != null ? `/${fmtNum(s.max)}` : ""}`)
        .join(", ")}`,
    );
  const sts = statusesOf(db, entity);
  if (sts.length)
    lines.push(`Statuses: ${sts.map((s) => s.label + (s.expires_at != null ? ` (until ${formatTime(s.expires_at)})` : "")).join("; ")}`);
  const inv = holdingsOf(db, entity).filter((h) => h.item !== GOLD);
  if (inv.length) lines.push(`Inventory: ${inv.map((h) => `${nameOf(db, h.item)} [${h.item}]${h.qty > 1 ? ` ×${h.qty}` : ""}`).join(", ")}`);
  else if (entity === PLAYER) lines.push("Inventory: nothing");
  return lines.join("\n");
}
