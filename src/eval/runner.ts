import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Components, Config, DeepPartial } from "../config.ts";
import { Game } from "../game.ts";
import { linkMention } from "../ingest/link.ts";
import { allOpenFacts } from "../memory/facts.ts";
import { getEntity } from "../state/read.ts";
import type { TurnResult } from "../turn/pipeline.ts";
import { norm } from "../util.ts";
import { sampleWorld } from "../world/sample.ts";
import { runComponentEvals } from "./components.ts";

// ── campaign format ─────────────────────────────────────────────────────────

const ProbeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recall"), question: z.string(), expect: z.array(z.string()).min(1), answer: z.string() }),
  z.object({ type: z.literal("consistency"), question: z.string(), expect: z.array(z.string()).min(1), answer: z.string() }),
  z.object({ type: z.literal("thread"), question: z.string(), expect: z.array(z.string()).min(1), answer: z.string().default("") }),
  z.object({
    type: z.literal("state"),
    entity: z.string(),
    alive: z.boolean().optional(),
    location: z.string().optional(),
    question: z.string().optional(),
    /** Statements that must not appear as current memories (the old location, being alive). */
    forbid: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("secrets"), question: z.string(), speaker: z.string(), forbid: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("aliases"), mentions: z.array(z.string()).min(2), entity: z.string() }),
  z.object({ type: z.literal("injected"), statement: z.string() }),
  z.object({ type: z.literal("branch"), question: z.string(), forbid: z.array(z.string()).min(1) }),
]);
export type Probe = z.infer<typeof ProbeSchema>;

const StepSchema = z.union([
  z.object({ input: z.string(), plant: z.string().optional() }),
  z.object({ probe: ProbeSchema }),
  z.object({ save: z.string() }),
  z.object({ rewind: z.string() }),
  z.object({ consolidate: z.literal(true) }),
]);

export const CampaignSchema = z.object({
  name: z.string(),
  world: z.enum(["sample", "generate"]).default("sample"),
  premise: z.string(),
  character: z.string(),
  seed: z.number().int().default(1),
  /** Filler turns after each scripted input, to stretch a campaign to 500–2,000 turns. */
  pad: z.object({ after: z.number().int().min(0), inputs: z.array(z.string()).min(1) }).optional(),
  script: z.array(StepSchema),
});
export type Campaign = z.infer<typeof CampaignSchema>;

// ── results ─────────────────────────────────────────────────────────────────

export interface ProbeResult {
  type: Probe["type"];
  step: number;
  turn: number;
  inContext: boolean;
  judged: boolean;
  correct: boolean | null;
  pass: boolean;
  rank: number | null;
  detail: string;
}

export interface EvalReport {
  campaign: string;
  provider: string;
  ablated: string[];
  at: string;
  turns: number;
  probes: ProbeResult[];
  metrics: {
    passRate: number;
    passRateByType: Record<string, { pass: number; total: number; rate: number }>;
    recallAt: Record<string, number>;
    contradictionsPer100: number;
    proseStateMismatchesPer100: number;
    duplicateEntities: number;
    latencyMsPerTurn: number;
    tokensPerTurn: number;
    costPerTurn: number;
  };
}

const JudgeSchema = z.object({ correct: z.boolean(), reason: z.string().default("") });

function contains(text: string, needles: string[]): boolean {
  const t = text.toLowerCase();
  return needles.some((n) => t.includes(n.toLowerCase()));
}

function rankOf(r: TurnResult, expect: string[]): number | null {
  const i = r.memories.findIndex((m) => contains(m.text, expect));
  return i < 0 ? null : i + 1;
}

function contextText(r: TurnResult): string {
  return `${r.planner?.text ?? ""}\n${r.narrator?.text ?? ""}`;
}

async function judge(game: Game, question: string, answer: string, prose: string): Promise<boolean | null> {
  if (game.ctx.config.provider === "mock" || !answer) return null; // no judge offline
  const r = await game.llm.structured(
    "verifier",
    "judge",
    [
      { role: "system", content: "You grade a game master's reply against the known correct answer. Correct means the reply states or clearly implies the answer, and does not contradict it." },
      { role: "user", content: `QUESTION: ${question}\nKNOWN ANSWER: ${answer}\nREPLY: ${prose}` },
    ],
    JudgeSchema,
    { fallback: { correct: false, reason: "judge failed" } },
  );
  return r.correct;
}

async function runProbe(game: Game, p: Probe, step: number): Promise<ProbeResult> {
  const base = { type: p.type, step, turn: game.head, judged: false, correct: null, rank: null } as ProbeResult;
  const ask = async (q: string) => {
    const head = game.head;
    const r = await game.play(q);
    await game.rewind(head); // probes never change the campaign
    return r;
  };
  switch (p.type) {
    case "recall":
    case "consistency":
    case "thread": {
      const r = await ask(p.question);
      const inContext = contains(contextText(r), p.expect);
      const correct = await judge(game, p.question, p.answer, r.prose);
      return { ...base, inContext, judged: correct != null, correct, rank: rankOf(r, p.expect), pass: inContext && correct !== false, detail: inContext ? "" : `missing: ${p.expect.join(" | ")}` };
    }
    case "state": {
      const e = getEntity(game.db, p.entity);
      const problems: string[] = [];
      if (!e) problems.push(`${p.entity} does not exist`);
      if (e && p.alive != null && !!e.alive !== p.alive) problems.push(`alive=${!!e.alive}`);
      if (e && p.location && e.location !== p.location) problems.push(`location=${e.location}`);
      let inContext = true;
      if (p.question) {
        const r = await ask(p.question);
        // The old truth must not be offered as a current memory.
        const current = r.memories.filter((m) => m.validTo == null).map((m) => m.text).join("\n");
        if (p.forbid.length && contains(current, p.forbid)) {
          inContext = false;
          problems.push("stale memory in context");
        }
      }
      return { ...base, inContext, pass: !problems.length, detail: problems.join("; ") };
    }
    case "secrets": {
      const r = await ask(p.question);
      const leakedToNarrator = contains(r.narrator?.text ?? "", p.forbid);
      const leakedInProse = contains(r.prose, p.forbid);
      return { ...base, inContext: !leakedToNarrator, pass: !leakedToNarrator && !leakedInProse, detail: [leakedToNarrator && "secret in NPC context", leakedInProse && "secret in prose"].filter(Boolean).join("; ") };
    }
    case "aliases": {
      const scene = [p.entity];
      const ids = [];
      for (const m of p.mentions) ids.push((await linkMention(game.ctx, m, scene, "")).id);
      const ok = ids.every((i) => i === p.entity);
      return { ...base, inContext: ok, pass: ok, detail: ok ? "" : `resolved to ${JSON.stringify(ids)}` };
    }
    case "injected": {
      await game.idle();
      const open = allOpenFacts(game.db).some((f) => norm(f.statement).includes(norm(p.statement)));
      const logged = !!game.db.query("SELECT 1 FROM drift_log WHERE statement LIKE ?").get(`%${p.statement}%`);
      return { ...base, inContext: !open, pass: !open, detail: open ? "planted line stored as a true fact" : logged ? "rejected and logged as drift" : "not stored" };
    }
    case "branch": {
      const r = await ask(p.question);
      const leaked = contains(contextText(r), p.forbid);
      return { ...base, inContext: !leaked, pass: !leaked, detail: leaked ? "abandoned-branch memory in context" : "" };
    }
  }
}

export async function runCampaign(c: Campaign, opts: { config?: DeepPartial<Config>; ablate?: (keyof Components)[]; db?: string; onTurn?: (n: number, r: TurnResult) => void } = {}): Promise<EvalReport> {
  const components: Partial<Components> = {};
  for (const a of opts.ablate ?? []) (components as any)[a] = false;
  const config: DeepPartial<Config> = { ...(opts.config ?? {}), components: { ...(opts.config?.components ?? {}), ...components } };
  const fixed = c.world === "sample" ? sampleWorld(c.character.match(/\bnamed ([A-Z][a-z]+)/)?.[1] ?? "Ash", c.character) : undefined;
  const { game } = await Game.create(opts.db ?? ":memory:", { premise: c.premise, character: c.character, fixed }, { config, rngSeed: c.seed });
  const probes: ProbeResult[] = [];
  const results: TurnResult[] = [];
  let turns = 0;
  const play = async (input: string, plant?: string) => {
    const r = await game.play(input, plant ? { editProse: (p) => `${p} ${plant}` } : {});
    results.push(r);
    turns++;
    opts.onTurn?.(turns, r);
  };
  for (const [i, step] of c.script.entries()) {
    if ("input" in step) {
      await play(step.input, step.plant);
      if (c.pad) for (let k = 0; k < c.pad.after; k++) await play(c.pad.inputs[(turns + k) % c.pad.inputs.length]);
    } else if ("probe" in step) probes.push(await runProbe(game, step.probe, i));
    else if ("save" in step) game.save(step.save);
    else if ("rewind" in step) await game.load(step.rewind);
    else if ("consolidate" in step) await game.consolidateNow();
  }
  await game.idle();

  const byType: Record<string, { pass: number; total: number; rate: number }> = {};
  for (const p of probes) {
    const b = (byType[p.type] ??= { pass: 0, total: 0, rate: 0 });
    b.total++;
    if (p.pass) b.pass++;
  }
  for (const b of Object.values(byType)) b.rate = b.total ? b.pass / b.total : 0;
  const ranked = probes.filter((p) => ["recall", "consistency", "thread"].includes(p.type));
  const recallAt: Record<string, number> = {};
  for (const k of [5, 10, 20]) recallAt[`@${k}`] = ranked.length ? ranked.filter((p) => p.rank != null && p.rank <= k).length / ranked.length : 0;
  const per100 = (n: number) => (turns ? (100 * n) / turns : 0);
  const drift = (game.db.query("SELECT COUNT(*) n FROM drift_log").get() as { n: number }).n;
  const conflicts = (game.db.query("SELECT COUNT(*) n FROM conflicts").get() as { n: number }).n;
  const mismatches = results.reduce((s, r) => s + r.verification.problems.length, 0);
  const dupRows = game.db
    .query("SELECT lower(name) n, COUNT(*) c FROM p_entities WHERE merged_into IS NULL GROUP BY lower(name) HAVING c > 1")
    .all() as { c: number }[];
  const calls = game.db.query("SELECT SUM(tokens_in + tokens_out) t, SUM(cost) c FROM llm_calls").get() as { t: number; c: number };
  const latency = results.reduce((s, r) => s + Object.values(r.timings).reduce((a, b) => a + b, 0), 0);
  const report: EvalReport = {
    campaign: c.name,
    provider: game.ctx.config.provider,
    ablated: opts.ablate ?? [],
    at: new Date().toISOString(),
    turns,
    probes,
    metrics: {
      passRate: probes.length ? probes.filter((p) => p.pass).length / probes.length : 0,
      passRateByType: byType,
      recallAt,
      contradictionsPer100: per100(drift + conflicts),
      proseStateMismatchesPer100: per100(mismatches),
      duplicateEntities: dupRows.reduce((s, r) => s + r.c - 1, 0),
      latencyMsPerTurn: turns ? latency / turns : 0,
      tokensPerTurn: turns ? (calls.t ?? 0) / turns : 0,
      costPerTurn: turns ? (calls.c ?? 0) / turns : 0,
    },
  };
  game.close();
  return report;
}

/** Metrics where higher is better vs lower is better, for regression checks. */
const HIGHER = ["passRate", "recallAt@5", "recallAt@10", "recallAt@20"];
const LOWER = ["contradictionsPer100", "proseStateMismatchesPer100", "duplicateEntities"];

export function flatMetrics(r: EvalReport): Record<string, number> {
  const m = r.metrics;
  return {
    passRate: m.passRate,
    "recallAt@5": m.recallAt["@5"],
    "recallAt@10": m.recallAt["@10"],
    "recallAt@20": m.recallAt["@20"],
    contradictionsPer100: m.contradictionsPer100,
    proseStateMismatchesPer100: m.proseStateMismatchesPer100,
    duplicateEntities: m.duplicateEntities,
    latencyMsPerTurn: m.latencyMsPerTurn,
    tokensPerTurn: m.tokensPerTurn,
    costPerTurn: m.costPerTurn,
  };
}

/** No silent regressions: a metric may not get worse by more than run-to-run noise. */
export function regressions(base: EvalReport, now: EvalReport, noise = 0.02): string[] {
  const a = flatMetrics(base), b = flatMetrics(now);
  const out: string[] = [];
  for (const k of HIGHER) if (b[k] < a[k] - noise) out.push(`${k}: ${a[k].toFixed(3)} → ${b[k].toFixed(3)}`);
  for (const k of LOWER) if (b[k] > a[k] + Math.max(noise, a[k] * noise)) out.push(`${k}: ${a[k].toFixed(3)} → ${b[k].toFixed(3)}`);
  return out;
}

export function loadCampaign(path: string): Campaign {
  return CampaignSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export const CAMPAIGN_DIR = join(import.meta.dir, "campaigns");

function printReport(r: EvalReport) {
  console.log(`\n${r.campaign}${r.ablated.length ? ` (without ${r.ablated.join(", ")})` : ""} · ${r.provider} · ${r.turns} turns`);
  for (const p of r.probes) console.log(`  ${p.pass ? "PASS" : "FAIL"} ${p.type.padEnd(12)} step ${p.step}${p.rank ? ` rank ${p.rank}` : ""}${p.detail ? ` — ${p.detail}` : ""}`);
  const m = flatMetrics(r);
  for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(28)} ${Number.isInteger(v) ? v : v.toFixed(3)}`);
}

export async function runEvalCli(pos: string[], flags: Record<string, string | boolean>) {
  const config: DeepPartial<Config> = flags.mock ? { provider: "mock" } : {};
  if (flags.components) {
    const r = await runComponentEvals(config);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const files = pos.length ? pos : readdirSync(CAMPAIGN_DIR).filter((f) => f.endsWith(".json")).map((f) => join(CAMPAIGN_DIR, f));
  const ablate = typeof flags.ablate === "string" ? (flags.ablate.split(",") as (keyof Components)[]) : [];
  const out = typeof flags.out === "string" ? flags.out : "eval-reports";
  mkdirSync(out, { recursive: true });
  let failed = false;
  for (const f of files) {
    const c = loadCampaign(f);
    const report = await runCampaign(c, { config, ablate, onTurn: (n) => n % 50 === 0 && process.stdout.write(`  …${n} turns\n`) });
    printReport(report);
    const name = `${basename(f, ".json")}${ablate.length ? `--no-${ablate.join("-")}` : ""}.json`;
    writeFileSync(join(out, name), JSON.stringify(report, null, 2));
    if (typeof flags.baseline === "string") {
      const base = JSON.parse(readFileSync(join(flags.baseline, `${basename(f, ".json")}.json`), "utf8")) as EvalReport;
      const reg = regressions(base, report, Number(flags.noise ?? 0.02));
      if (reg.length) {
        failed = true;
        console.log(`  REGRESSIONS vs baseline:\n  - ${reg.join("\n  - ")}`);
      } else console.log("  no regressions vs baseline");
    }
  }
  if (failed) process.exitCode = 1;
}
