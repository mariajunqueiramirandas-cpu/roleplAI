import { z } from "zod";
import type { Ctx } from "../ctx.ts";
import { exactAliasMatches, isPlace, keywordNameMatches } from "../memory/entities.ts";
import { vectorSearch } from "../memory/vectors.ts";
import { canonical, getEntity } from "../state/read.ts";
import { norm, PLAYER, words } from "../util.ts";

export interface LinkResult {
  mention: string;
  id: string | null;
  method: "id" | "self" | "alias" | "keyword" | "vector" | "rerank" | "model" | "none";
  candidates: string[];
}

const PRONOUNS = new Set(["he", "him", "his", "she", "her", "hers", "they", "them", "their", "it", "its"]);
const SELF = new Set(["i", "me", "my", "myself", "mine", "you", "your", "yourself", "player"]);

const ChoiceSchema = z.object({ choice: z.string().describe("The chosen entity id, or 'none'") });

/**
 * Mention → entity id: exact alias → keyword search on names → vector search on
 * profiles → rerank. The `fast` model decides only when the top candidates are close.
 */
export async function linkMention(ctx: Ctx, mention: string, scene: string[], context: string, knownId?: string | null): Promise<LinkResult> {
  const { db } = ctx;
  if (knownId && getEntity(db, knownId)) return { mention, id: canonical(db, knownId), method: "id", candidates: [] };
  const n = norm(mention);
  if (SELF.has(n)) return { mention, id: PLAYER, method: "self", candidates: [] };

  const exact = exactAliasMatches(db, mention);
  if (exact.length === 1) return { mention, id: exact[0], method: "alias", candidates: exact };
  if (exact.length > 1) {
    const inScene = exact.filter((e) => scene.includes(e));
    if (inScene.length === 1) return { mention, id: inScene[0], method: "alias", candidates: exact };
  }

  let candidates: string[] = [...exact];
  if (PRONOUNS.has(n)) {
    candidates = scene.filter((s) => s !== PLAYER && getEntity(db, s) && !isPlace(getEntity(db, s)!.kind));
    if (candidates.length === 1) return { mention, id: candidates[0], method: "alias", candidates };
  } else {
    if (ctx.config.components.keyword) {
      const kw = keywordNameMatches(db, mention, 8);
      const mw = words(mention);
      // A name match containing every word of the mention is decisive when unique.
      const full = kw.filter((k) => {
        const e = getEntity(db, k.entity)!;
        const nameWords = new Set(words(e.name));
        return mw.length > 0 && mw.every((w) => nameWords.has(w));
      });
      if (full.length === 1 && !exact.length) return { mention, id: full[0].entity, method: "keyword", candidates: kw.map((k) => k.entity) };
      candidates.push(...kw.map((k) => k.entity));
    }
    if (ctx.config.components.vector) {
      try {
        const [v] = await ctx.llm.embed([`${mention} — ${context}`.slice(0, 500)]);
        const vs = vectorSearch(db, ctx.config.roles.embed.model, v, ["profile"], 6).filter((r) => r.distance < 0.6);
        candidates.push(...vs.map((r) => canonical(db, r.item)));
      } catch {
        // no vectors: keyword only
      }
    }
  }
  candidates = [...new Set(candidates)].filter((c) => getEntity(db, c));
  if (!candidates.length) return { mention, id: null, method: "none", candidates };

  const docs = candidates.map((c) => {
    const e = getEntity(db, c)!;
    return `${e.name} (${e.kind}): ${e.profile || e.description}`;
  });
  let ranked = candidates.map((c, i) => ({ id: c, score: 0, i }));
  const rr = ctx.config.components.rerank ? await ctx.llm.rerank(`${mention}. Context: ${context}`, docs) : null;
  if (rr) {
    for (const r of rr) ranked[r.index].score = r.score;
    ranked = [...ranked].sort((a, b) => b.score - a.score);
    const [a, b] = ranked;
    const sceneBonus = (x: typeof a) => (x && scene.includes(x.id) ? 0.1 : 0);
    if (a && a.score + sceneBonus(a) >= 0.5 && (!b || a.score + sceneBonus(a) - (b.score + sceneBonus(b)) >= 0.15)) {
      return { mention, id: a.id, method: "rerank", candidates };
    }
    if (a && a.score < 0.1 && !exact.length && !PRONOUNS.has(n)) return { mention, id: null, method: "none", candidates };
  }
  // Close call: ask the fast model.
  const top = ranked.slice(0, 4);
  const list = top
    .map((t) => {
      const e = getEntity(db, t.id)!;
      return `- ${e.id}: ${e.name} (${e.kind})${scene.includes(e.id) ? " [in the scene]" : ""} — ${e.profile || e.description}`;
    })
    .join("\n");
  const r = await ctx.llm.structured(
    "fast",
    "link",
    [
      { role: "system", content: "You resolve a mention in a role-playing game to a known entity. Answer with the id, or 'none' if it is someone or something new." },
      { role: "user", content: `Mention: "${mention}"\nContext: ${context}\nCandidates:\n${list}` },
    ],
    ChoiceSchema,
    { fallback: { choice: top[0]?.id ?? "none" }, meta: { mention, candidates: top.map((t) => t.id), scene } },
  );
  const id = r.choice !== "none" && getEntity(db, r.choice) ? canonical(db, r.choice) : null;
  return { mention, id, method: id ? "model" : "none", candidates };
}
