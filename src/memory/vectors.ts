import type { DB } from "../db/db.ts";
import { vis } from "../db/lineage.ts";
import type { LLM } from "../llm/client.ts";
import type { Origin } from "./entities.ts";

export type VecItemType = "fact" | "episode" | "profile";

export interface VecInput {
  type: VecItemType;
  item: string | number;
  text: string;
}

/** Embed and store. Every vector records the model that made it. */
export async function storeEmbeddings(db: DB, llm: LLM, items: VecInput[], o: Origin) {
  const todo = items.filter((i) => i.text.trim());
  if (!todo.length || !llm.config.components.vector) return;
  const vectors = await llm.embed(todo.map((i) => i.text));
  const model = llm.config.roles.embed.model;
  db.transaction(() => {
    todo.forEach((it, i) => {
      const r = db
        .query("INSERT INTO embeddings(item_type, item, model, segment, turn) VALUES (?, ?, ?, ?, ?)")
        .run(it.type, String(it.item), model, o.segment, o.turn);
      db.query("INSERT INTO vec_items(id, embedding) VALUES (?, ?)").run(Number(r.lastInsertRowid), new Float32Array(vectors[i]));
    });
  })();
}

/**
 * Exact nearest neighbours on the current timeline. At campaign scale (~15k vectors)
 * a full scan is fast, and it keeps the lineage filter exact.
 */
export function vectorSearch(
  db: DB,
  model: string,
  query: number[],
  types: VecItemType[],
  limit: number,
): { type: VecItemType; item: string; distance: number }[] {
  const ph = types.map(() => "?").join(",");
  return db
    .query(
      `SELECT e.item_type AS type, e.item AS item, vec_distance_cosine(v.embedding, ?) AS distance
       FROM embeddings e JOIN vec_items v ON v.id = e.id
       WHERE e.item_type IN (${ph}) AND e.model = ? AND ${vis("e")}
         AND e.id = (SELECT MAX(e2.id) FROM embeddings e2 WHERE e2.item_type = e.item_type AND e2.item = e.item AND e2.model = e.model AND ${vis("e2")})
       ORDER BY distance LIMIT ?`,
    )
    .all(new Float32Array(query), ...types, model, limit) as { type: VecItemType; item: string; distance: number }[];
}

export function vectorOf(db: DB, type: VecItemType, item: string | number, model: string): Float32Array | null {
  const r = db
    .query(
      `SELECT v.embedding FROM embeddings e JOIN vec_items v ON v.id = e.id
       WHERE e.item_type = ? AND e.item = ? AND e.model = ? AND ${vis("e")} ORDER BY e.id DESC LIMIT 1`,
    )
    .get(type, String(item), model) as { embedding: Uint8Array } | null;
  return r ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : null;
}

/** Background job after the embed model changes: re-embed rows made by another model. */
export async function reembedStale(db: DB, llm: LLM, textOf: (type: VecItemType, item: string) => string | null) {
  const model = llm.config.roles.embed.model;
  const rows = db
    .query("SELECT id, item_type, item, segment, turn FROM embeddings WHERE model != ? ORDER BY id")
    .all(model) as { id: number; item_type: VecItemType; item: string; segment: number; turn: number }[];
  for (const r of rows) {
    const text = textOf(r.item_type, r.item);
    if (text) await storeEmbeddings(db, llm, [{ type: r.item_type, item: r.item, text }], { segment: r.segment, turn: r.turn, gameTime: 0 });
  }
  return rows.length;
}
