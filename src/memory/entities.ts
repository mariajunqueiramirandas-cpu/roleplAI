import type { DB } from "../db/db.ts";
import { vis } from "../db/lineage.ts";
import { canonical, getEntity, type EntityRow } from "../state/read.ts";
import { norm, PLAYER, WORLD } from "../util.ts";

/** Where a memory row comes from: the turn, its segment and the in-game time. */
export interface Origin {
  segment: number;
  turn: number;
  gameTime: number;
}

export function addAlias(db: DB, entity: string, alias: string, o: Origin) {
  const n = norm(alias);
  if (!n) return;
  const exists = db
    .query(`SELECT 1 FROM aliases a WHERE a.entity = ? AND a.norm = ? AND ${vis("a")}`)
    .get(entity, n);
  if (exists) return;
  const r = db
    .query("INSERT INTO aliases(entity, alias, norm, segment, turn) VALUES (?, ?, ?, ?, ?)")
    .run(entity, alias, n, o.segment, o.turn);
  db.query("INSERT INTO names_fts(rowid, alias) VALUES (?, ?)").run(Number(r.lastInsertRowid), n);
}

export function aliasesOf(db: DB, entity: string): string[] {
  return (
    db.query(`SELECT DISTINCT a.alias FROM aliases a WHERE a.entity = ? AND ${vis("a")} ORDER BY a.id`).all(entity) as {
      alias: string;
    }[]
  ).map((r) => r.alias);
}

/** Entities whose visible aliases match the normalised mention exactly. */
export function exactAliasMatches(db: DB, mention: string): string[] {
  const n = norm(mention);
  if (!n) return [];
  const rows = db
    .query(`SELECT DISTINCT a.entity FROM aliases a WHERE a.norm = ? AND ${vis("a")}`)
    .all(n) as { entity: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    const c = canonical(db, r.entity);
    if (getEntity(db, c)) ids.add(c);
  }
  return [...ids];
}

/** Keyword search over names (BM25). */
export function keywordNameMatches(db: DB, mention: string, limit = 10): { entity: string; score: number }[] {
  const ws = norm(mention).split(" ").filter((w) => w.length > 1);
  if (!ws.length) return [];
  const q = ws.map((w) => `"${w.replace(/"/g, "")}"*`).join(" OR ");
  try {
    // bm25() can't be aggregated, so rank rows and keep each entity's best.
    const rows = db
      .query(
        `SELECT a.entity, bm25(names_fts) s FROM names_fts JOIN aliases a ON a.id = names_fts.rowid
         WHERE names_fts MATCH ? AND ${vis("a")} ORDER BY s LIMIT ?`,
      )
      .all(q, limit * 5) as { entity: string; s: number }[];
    const out = new Map<string, number>();
    for (const r of rows) {
      const c = canonical(db, r.entity);
      if (getEntity(db, c) && !out.has(c)) out.set(c, -r.s);
    }
    return [...out].slice(0, limit).map(([entity, score]) => ({ entity, score }));
  } catch {
    return [];
  }
}

/**
 * Resolve a reference the planner wrote (an id or a name) to an entity id.
 * Prefers entities in `preferIn` (usually the current scene) when names collide.
 */
export function resolveRef(db: DB, ref: string, preferIn: string[] = []): string | null {
  if (!ref) return null;
  const r = ref.trim();
  if (r === PLAYER || r === WORLD) return r;
  if (getEntity(db, r)) return canonical(db, r);
  const lower = r.toLowerCase();
  if (getEntity(db, lower)) return canonical(db, lower);
  if (["me", "myself", "i", "you", "the player"].includes(lower)) return PLAYER;
  const matches = exactAliasMatches(db, r);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches.find((m) => preferIn.includes(m)) ?? matches[0];
  return null;
}

export function allEntities(db: DB): EntityRow[] {
  return db.query("SELECT * FROM p_entities WHERE merged_into IS NULL ORDER BY created_turn, id").all() as EntityRow[];
}

/** Unique id for a new entity: kind prefix + slug of the name. */
export function newEntityId(db: DB, kind: string, name: string, wanted?: string): string {
  const prefix = kindPrefix(kind);
  const slugName = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^(the|a|an) /, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "x";
  let base = wanted && /^[a-z0-9_]+$/.test(wanted) ? wanted : `${prefix}_${slugName}`;
  if (base === PLAYER || base === WORLD) base = `${prefix}_${base}`;
  let id = base;
  for (let i = 2; db.query("SELECT 1 FROM p_entities WHERE id = ?").get(id); i++) id = `${base}_${i}`;
  return id;
}

/** Kinds that name a location. Kind is free text, so this is a broad match. */
export const PLACE_RE =
  /(place|location|town|city|village|hamlet|region|room|building|tavern|inn\b|forest|dungeon|tower|area|land|smithy|forge|shop|store|market|square|temple|church|castle|keep|cave|mine|mill|farm|road|bridge|port|harbou?r|camp|ruin|hall|house|street|district|ridge|mountain|river|lake|valley|moor|marsh|wood|field|plain|island|chamber|cellar|vault|shrine|gate|fort|realm|kingdom|country|world)/;

export function isPlace(kind: string): boolean {
  return PLACE_RE.test(kind.toLowerCase()) && !/(npc|person|keeper|smith\b|owner)/.test(kind.toLowerCase());
}

/** Things that can witness, speak or act: not places, items or organisations. */
export function isBeing(kind: string): boolean {
  const k = kind.toLowerCase();
  if (/(npc|person|character|creature|monster|beast|animal|spirit|human)/.test(k)) return true;
  return !isPlace(k) && !/(item|object|weapon|armou?r|tool|potion|faction|guild|order|cult|religion|disease|organi[sz]ation|company|army|clan|house|region)/.test(k);
}

export function kindPrefix(kind: string): string {
  const k = kind.toLowerCase();
  if (/(npc|person|character|human|villager|merchant|noble|guard|keeper|smith\b)/.test(k)) return "npc";
  if (isPlace(k)) return "place";
  if (/(item|weapon|armor|armour|object|tool|potion|artifact|artefact)/.test(k)) return "item";
  if (/(faction|guild|order|cult|house|clan|army)/.test(k)) return "faction";
  if (/(creature|monster|beast|animal)/.test(k)) return "creature";
  return k.replace(/[^a-z]+/g, "").slice(0, 10) || "thing";
}

export function isPlaceKind(kind: string) {
  return isPlace(kind);
}
