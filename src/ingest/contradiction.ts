import { z } from "zod";
import { CONTRADICTION_SYSTEM } from "../context/prompts.ts";
import type { Ctx } from "../ctx.ts";
import type { Origin } from "../memory/entities.ts";
import {
  addKnowledge,
  addSource,
  AUTHORITY_RANK,
  closeFact,
  factsAbout,
  insertFact,
  type Fact,
  type NewFact,
} from "../memory/facts.ts";
import { storeEmbeddings, vectorOf } from "../memory/vectors.ts";
import { nameOf } from "../state/read.ts";
import { cosine, formatTime, words } from "../util.ts";

export const LABELS = ["duplicate", "new_detail", "update", "contradiction"] as const;
export type Label = (typeof LABELS)[number];

export const LabelsSchema = z.object({
  labels: z.array(z.object({ id: z.number().int(), label: z.enum(LABELS) })),
});

export type Decision =
  | { action: "duplicate"; of: number }
  | { action: "add" }
  | { action: "update"; closes: number[] }
  | { action: "reject"; against: number; reason: string }
  | { action: "conflict"; against: number };

/** Candidates: the subject's currently valid facts closest in meaning to the new one. */
export async function nearbyFacts(ctx: Ctx, nf: NewFact, limit = 6): Promise<Fact[]> {
  const facts = factsAbout(ctx.db, nf.subject);
  if (!facts.length) return [];
  const nw = new Set(words(nf.statement));
  const overlap = (f: Fact) => {
    const fw = words(f.statement);
    return fw.length ? fw.filter((w) => nw.has(w)).length / Math.sqrt(fw.length * Math.max(1, nw.size)) : 0;
  };
  let sim = new Map<number, number>();
  if (ctx.config.components.vector) {
    try {
      const [q] = await ctx.llm.embed([nf.statement]);
      const model = ctx.config.roles.embed.model;
      for (const f of facts) {
        const v = vectorOf(ctx.db, "fact", f.id, model);
        if (v) sim.set(f.id, cosine(q, v));
      }
    } catch {
      sim = new Map();
    }
  }
  return facts
    .map((f) => ({ f, s: Math.max(sim.get(f.id) ?? 0, overlap(f)) }))
    .filter((x) => x.s >= 0.2 || (nf.predicate && x.f.predicate && x.f.predicate === nf.predicate))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

export async function labelPairs(ctx: Ctx, nf: NewFact, candidates: Fact[]): Promise<Map<number, Label>> {
  const out = new Map<number, Label>();
  if (!candidates.length) return out;
  const r = await ctx.llm.structured(
    "verifier",
    "contradiction",
    [
      { role: "system", content: CONTRADICTION_SYSTEM },
      {
        role: "user",
        content: `Entity: ${nameOf(ctx.db, nf.subject)} [${nf.subject}]\nNEW (${nf.authority}): ${nf.statement}\nEXISTING:\n${candidates
          .map((f) => `- id ${f.id} (${f.authority}, since ${formatTime(f.valid_from_time)}): ${f.statement}`)
          .join("\n")}`,
      },
    ],
    LabelsSchema,
    {
      fallback: { labels: candidates.map((c) => ({ id: c.id, label: "new_detail" as const })) },
      meta: { new: nf.statement, existing: candidates.map((c) => ({ id: c.id, statement: c.statement })) },
    },
  );
  for (const l of r.labels) if (candidates.some((c) => c.id === l.id)) out.set(l.id, l.label);
  return out;
}

/** Decide what to do with a new fact, without writing anything. */
export async function classifyFact(ctx: Ctx, nf: NewFact): Promise<{ decision: Decision; candidates: Fact[]; labels: Map<number, Label> }> {
  const candidates = await nearbyFacts(ctx, nf);
  const labels = await labelPairs(ctx, nf, candidates);
  const byLabel = (l: Label) => candidates.filter((c) => labels.get(c.id) === l);
  const dup = byLabel("duplicate")[0];
  const contra = byLabel("contradiction");
  const upd = byLabel("update");
  const rNew = AUTHORITY_RANK[nf.authority];
  for (const old of contra) {
    const rOld = AUTHORITY_RANK[old.authority];
    if (rNew > rOld) {
      upd.push(old); // the stronger source wins: treat as an update of the weaker fact
      continue;
    }
    if (old.authority === "state" || old.authority === "canon") {
      return { decision: { action: "reject", against: old.id, reason: `contradicts ${old.authority}: "${old.statement}"` }, candidates, labels };
    }
    if (old.authority === "narrative" && nf.authority === "narrative") return { decision: { action: "conflict", against: old.id }, candidates, labels };
    return { decision: { action: "reject", against: old.id, reason: `weaker than ${old.authority}: "${old.statement}"` }, candidates, labels };
  }
  if (dup) return { decision: { action: "duplicate", of: dup.id }, candidates, labels };
  if (upd.length) return { decision: { action: "update", closes: upd.map((u) => u.id) }, candidates, labels };
  return { decision: { action: "add" }, candidates, labels };
}

/** Apply a decision. Returns the new fact id, if one was stored. */
export async function applyDecision(ctx: Ctx, nf: NewFact, d: Decision, o: Origin, logDrift = true): Promise<number | null> {
  const { db } = ctx;
  switch (d.action) {
    case "duplicate":
      addSource(db, d.of, o);
      for (const k of nf.knownBy) addKnowledge(db, "fact", d.of, k, o);
      return null;
    case "add": {
      const id = insertFact(db, nf, o);
      await storeEmbeddings(db, ctx.llm, [{ type: "fact", item: id, text: nf.statement }], o).catch(() => undefined);
      return id;
    }
    case "update": {
      const id = insertFact(db, nf, o);
      for (const c of d.closes) closeFact(db, c, id, o);
      await storeEmbeddings(db, ctx.llm, [{ type: "fact", item: id, text: nf.statement }], o).catch(() => undefined);
      return id;
    }
    case "reject":
      if (logDrift)
        db.query("INSERT INTO drift_log(turn, segment, statement, against, reason) VALUES (?, ?, ?, ?, ?)").run(
          o.turn,
          o.segment,
          nf.statement,
          d.against,
          d.reason,
        );
      return null;
    case "conflict": {
      // Keep the old fact true; store the new one already closed, and queue the pair.
      const id = insertFact(db, nf, o);
      closeFact(db, id, null, o);
      db.query("INSERT INTO conflicts(fact_a, fact_b, segment, turn) VALUES (?, ?, ?, ?)").run(d.against, id, o.segment, o.turn);
      await storeEmbeddings(db, ctx.llm, [{ type: "fact", item: id, text: nf.statement }], o).catch(() => undefined);
      return id;
    }
  }
}

export async function rememberFact(ctx: Ctx, nf: NewFact, o: Origin): Promise<{ decision: Decision; id: number | null }> {
  const { decision } = await classifyFact(ctx, nf);
  const id = await applyDecision(ctx, nf, decision, o);
  return { decision, id };
}
