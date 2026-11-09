import { z } from "zod";
import { buildContext, type BuiltContext, type Understanding } from "../context/builder.ts";
import { UNDERSTAND_SYSTEM, VERIFIER_PROSE_SYSTEM } from "../context/prompts.ts";
import type { Ctx } from "../ctx.ts";
import { getMeta } from "../db/db.ts";
import { getHead, headSegment } from "../db/lineage.ts";
import { classifyFact } from "../ingest/contradiction.ts";
import type { TurnOutcome } from "../ingest/extract.ts";
import { linkMention } from "../ingest/link.ts";
import type { Origin } from "../memory/entities.ts";
import { recentTurns } from "../memory/episodes.ts";
import { retrieve, type RetrieveDebug, type Scored } from "../retrieval/retrieve.ts";
import { presentEntities, resolvePlan, seedFor, type Rejection, type Resolution } from "../state/engine.ts";
import { activeThreads, gameTime, getEntity, hardStateLine, holding, nameOf } from "../state/read.ts";
import { parseToolCall, toolDefinitions, type Action } from "../state/tools.ts";
import { GOLD, PLAYER, words } from "../util.ts";
import { isBeing } from "../memory/entities.ts";
import { applyEvent } from "../state/projection.ts";
import { touchedStubs } from "../world/stubs.ts";
import { commitTurn } from "./commit.ts";

export const UnderstandSchema = z.object({
  intent: z.enum(["action", "dialogue", "question", "ooc"]),
  mentions: z.array(z.string()).default([]),
  target: z.string().nullish(),
  refersToPast: z.boolean().default(false),
  queries: z.array(z.string()).max(4).default([]),
});

export const ProseCheckSchema = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()).default([]),
});

export interface TurnResult {
  turn: number | null;
  prose: string;
  ooc: boolean;
  understanding: Understanding;
  linked: Record<string, string | null>;
  mechanics: string[];
  notes: string[];
  rejections: Rejection[];
  dropped: Rejection[];
  plan: Action[];
  planner: BuiltContext | null;
  narrator: BuiltContext | null;
  memories: Scored[];
  retrieval: RetrieveDebug;
  verification: { problems: string[]; regenerated: boolean };
  timings: Record<string, number>;
  /** Hard-state line after the turn. */
  state: string;
}

export interface PipelineHooks {
  /** Queue the background write path for a committed turn. */
  remember: (turn: number, factIds: number[], origin: Origin) => void;
  /** Wait until extraction is no further behind than the verbatim window. */
  waitForMemory: () => Promise<void>;
  reflect: (npcs: string[]) => Promise<void>;
  /** Evals only: change the prose after verification (to plant a contradiction). */
  editProse?: (prose: string) => string;
}

function heuristicUnderstanding(input: string): Understanding {
  const t = input.trim();
  const ooc = /^\(\(|^ooc[:\s]|^\[ooc/i.test(t);
  const dialogue = /^["“']|^(say|ask|tell|whisper|shout)\b/i.test(t);
  const question = /\?\s*$/.test(t) && !dialogue;
  return {
    intent: ooc ? "ooc" : dialogue ? "dialogue" : question ? "question" : "action",
    mentions: [...t.matchAll(/\b([A-Z][a-z'’]+(?:\s+[A-Z][a-z'’]+)*)\b/g)].map((m) => m[1]).filter((m) => !/^(I|The|A|An)$/.test(m)),
    target: null,
    refersToPast: /\b(earlier|before|back then|last time|ago|remember|did .* say)\b/i.test(t),
    queries: [],
  };
}

/** Step 1: intent and mentions (fast model). */
export async function understand(ctx: Ctx, input: string): Promise<Understanding> {
  const recent = recentTurns(ctx.db, 2).map((t) => `Player: ${t.input}\nGM: ${t.prose}`).join("\n\n");
  const present = presentEntities(ctx.db).map((id) => `${nameOf(ctx.db, id)} [${id}]`).join(", ");
  const r = await ctx.llm.structured(
    "fast",
    "understand",
    [
      { role: "system", content: UNDERSTAND_SYSTEM },
      { role: "user", content: `PRESENT: ${present}\nRECENT:\n${recent || "(start of the game)"}\n\nPLAYER INPUT: ${input}` },
    ],
    UnderstandSchema,
    { fallback: heuristicUnderstanding(input), meta: { input, present: presentEntities(ctx.db) } },
  );
  return { ...r, target: r.target ?? null };
}

/** Steps 4: plan as tool calls. Invalid arguments get one repair call; then a no-change plan. */
async function plan(ctx: Ctx, built: BuiltContext, meta: Record<string, unknown>): Promise<{ actions: Action[]; note: string; errors: string[] }> {
  const tools = toolDefinitions();
  const parse = (calls: { name: string; arguments: string }[]) => {
    const actions: Action[] = [];
    const errors: string[] = [];
    for (const c of calls) {
      let args: unknown;
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        errors.push(`${c.name}: arguments are not valid JSON`);
        continue;
      }
      const p = parseToolCall(c.name, args);
      if (p.ok) actions.push(p.action);
      else errors.push(p.error);
    }
    return { actions, errors };
  };
  let res;
  try {
    res = await ctx.llm.withTools("planner", "plan", built.messages, tools, meta);
  } catch {
    return { actions: [], note: "", errors: ["planner call failed"] };
  }
  let { actions, errors } = parse(res.toolCalls);
  if (errors.length) {
    try {
      const repair = await ctx.llm.withTools(
        "planner",
        "plan_repair",
        [
          ...built.messages,
          { role: "assistant", content: res.content || "", tool_calls: res.toolCalls },
          ...res.toolCalls.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "not applied" })),
          { role: "user", content: `Some tool calls were invalid:\n- ${errors.join("\n- ")}\nSend the complete plan again with valid arguments.` },
        ],
        tools,
        { ...meta, repair: errors },
      );
      const second = parse(repair.toolCalls);
      if (!second.errors.length || second.actions.length) ({ actions, errors } = second);
    } catch {
      // keep the valid part of the first plan
    }
  }
  return { actions, note: res.content?.trim() ?? "", errors };
}

/** Facts the plan records go through the contradiction checks before the turn happens. */
async function checkPlannedFacts(ctx: Ctx, r: Resolution): Promise<Rejection[]> {
  const out: Rejection[] = [];
  for (const m of r.memory) {
    if (m.kind !== "fact") continue;
    const { decision } = await classifyFact(ctx, { ...m.fact, knownBy: m.fact.knownBy.length ? m.fact.knownBy : [PLAYER] });
    if (decision.action === "reject") out.push({ action: `record_fact(${m.fact.statement})`, reason: `Rejected: it ${decision.reason}.` });
  }
  return out;
}

/** Hard state as it will be after the turn, captured for the checks. */
export interface PostState {
  hardLine: string;
  gold: number;
  present: { id: string; name: string; alive: boolean }[];
}

function postState(ctx: Ctx): PostState {
  const { db } = ctx;
  const loc = getEntity(db, PLAYER)?.location;
  const here = loc ? (db.query("SELECT id, name, alive, kind FROM p_entities WHERE location = ? AND merged_into IS NULL").all(loc) as any[]) : [];
  return {
    hardLine: hardStateLine(db, PLAYER),
    gold: holding(db, PLAYER, GOLD),
    present: here.filter((e) => isBeing(e.kind) && e.id !== PLAYER).map((e) => ({ id: e.id, name: e.name, alive: !!e.alive })),
  };
}

/** Step 7a: cheap code checks on the prose. */
export function codeChecks(prose: string, narr: BuiltContext, memories: Scored[], resolution: Resolution, post: PostState): string[] {
  const problems: string[] = [];
  if (!prose.trim()) problems.push("The prose is empty.");
  if (/<\/?tool|\{"tool"|function_call/i.test(prose)) problems.push("The prose contains tool-call markup.");
  const pw = new Set(words(prose));
  for (const m of memories) {
    if (!m.secret || m.knownBy.includes(PLAYER) || m.knownBy.includes("*")) continue;
    if (!narr.includedKeys.includes(m.key)) continue;
    const mw = [...new Set(words(m.text))];
    const hit = mw.filter((w) => pw.has(w)).length;
    if (mw.length >= 5 && hit / mw.length >= 0.75) problems.push(`The prose appears to reveal a secret the player doesn't know: "${m.text}"`);
  }
  const goldClaim = prose.match(/you (?:now )?(?:have|hold|carry|are left with) (\d+) gold/i);
  if (goldClaim && Number(goldClaim[1]) !== post.gold) {
    problems.push(`The prose says the player has ${goldClaim[1]} gold; they have ${post.gold}.`);
  }
  for (const e of post.present) {
    if (e.alive) continue;
    const re = new RegExp(`\\b${e.name.split(" ")[0]}\\b[^.!?]{0,40}\\b(says|said|asks|asked|replies|replied|smiles|nods|laughs|walks|stands)\\b`, "i");
    if (re.test(prose)) problems.push(`${e.name} is dead but acts or speaks in the prose.`);
  }
  for (const c of resolution.checks) {
    const verb = c.description.toLowerCase().split(" ")[0];
    if (!c.success && new RegExp(`\\byou (succeed|manage) (to|in) ${verb}`).test(prose.toLowerCase())) {
      problems.push(`"${c.description}" failed, but the prose describes success.`);
    }
  }
  return problems;
}

/** Step 7b: the verifier model checks prose against state and outcome. */
async function verifyProse(ctx: Ctx, prose: string, resolution: Resolution, memories: Scored[], post: PostState): Promise<string[]> {
  const facts = memories.slice(0, 20).map((m) => `${m.secret ? "[SECRET] " : ""}${m.text}`);
  const r = await ctx.llm.structured(
    "verifier",
    "verify_prose",
    [
      { role: "system", content: VERIFIER_PROSE_SYSTEM },
      {
        role: "user",
        content: [
          `RESOLVED OUTCOME\n${resolution.mechanics.map((m) => `- ${m}`).join("\n") || "- none"}`,
          resolution.notes.length ? `NOTES\n${resolution.notes.map((n) => `- ${n}`).join("\n")}` : "",
          `HARD STATE (after this turn)\n${post.hardLine}`,
          `PRESENT\n${post.present.map((e) => `- ${e.name}${e.alive ? "" : " (DEAD)"}`).join("\n") || "- nobody else"}`,
          `RELEVANT FACTS\n${facts.map((f) => `- ${f}`).join("\n")}`,
          `PROSE\n${prose}`,
        ].filter(Boolean).join("\n\n"),
      },
    ],
    ProseCheckSchema,
    { fallback: { ok: true, problems: [] }, meta: { prose, mechanics: resolution.mechanics } },
  );
  return r.ok ? [] : r.problems;
}

/** Steps 1–9 for one player input. */
export async function runTurn(ctx: Ctx, input: string, hooks: PipelineHooks): Promise<TurnResult> {
  const { db, config } = ctx;
  const timings: Record<string, number> = {};
  const tick = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };
  ctx.llm.turn = getHead(db) + 1;

  // No gap in memory: wait if extraction is too far behind.
  await tick("wait_memory", hooks.waitForMemory);

  const u = await tick("understand", () => understand(ctx, input));
  const scene = [...new Set([...presentEntities(db), getEntity(db, PLAYER)?.location].filter((x): x is string => !!x))];
  const empty: TurnResult = {
    turn: null,
    prose: "",
    ooc: false,
    understanding: u,
    linked: {},
    mechanics: [],
    notes: [],
    rejections: [],
    dropped: [],
    plan: [],
    planner: null,
    narrator: null,
    memories: [],
    retrieval: { lists: {}, fused: [] },
    verification: { problems: [], regenerated: false },
    timings,
    state: "",
  };

  // Step 2: link mentions to ids.
  const linked: Record<string, string | null> = {};
  await tick("link", async () => {
    const context = `${input}\n${recentTurns(db, 1).map((t) => t.prose).join("\n")}`.slice(0, 500);
    for (const m of u.mentions) linked[m] = (await linkMention(ctx, m, scene, context)).id;
    if (u.target) linked[u.target] ??= (await linkMention(ctx, u.target, scene, context)).id;
  });
  const linkedIds = [...new Set(Object.values(linked).filter((x): x is string => !!x))];
  const speaker = u.intent === "dialogue" && u.target ? (linked[u.target] ?? null) : null;

  // NPC reflections, for NPCs about to appear.
  if (config.components.reflections) await tick("reflect", () => hooks.reflect(scene.filter((s) => s.startsWith("npc_") || getEntity(db, s)?.kind === "npc")));

  // Step 3: retrieve.
  const retrievalDebug: RetrieveDebug = { lists: {}, fused: [] };
  const threadNames = activeThreads(db).slice(0, 5).map((t) => t.title);
  const queries = [input, ...linkedIds.map((id) => nameOf(db, id)), ...threadNames, ...u.queries].filter(Boolean).slice(0, 10);
  const memories = await tick("retrieve", () =>
    retrieve(
      ctx,
      { queries, sceneEntities: scene, linked: linkedIds, refersToPast: u.refersToPast, excludeTurns: recentTurns(db, config.recentTurns).map((t) => t.id) },
      retrievalDebug,
    ),
  );
  const stubs = touchedStubs(db, linkedIds, scene);

  // Out-of-character: answer as the GM, change nothing, commit nothing.
  if (u.intent === "ooc") {
    const built = buildContext(ctx, { role: "narrator", input, understanding: u, sceneEntities: scene, linked: linkedIds, memories, stubs: [], mechanics: [] });
    built.messages.push({ role: "user", content: "This is an out-of-character question. Answer briefly as the game master, without narrating story events." });
    const prose = await tick("narrate", () => ctx.llm.text("narrator", "ooc", built.messages, { input }));
    return { ...empty, prose, ooc: true, linked, memories, retrieval: retrievalDebug, narrator: built, state: hardStateLine(db) };
  }

  // Steps 4–5: plan, resolve; invalid changes go back to the planner once.
  const turnSeed = Number(getMeta(db, "seed") ?? 1);
  let planner: BuiltContext | null = null;
  let actions: Action[] = [];
  let note = "";
  let resolution: Resolution;
  let firstRejections: Rejection[] = [];
  const skipPlanner = config.components.skipPlannerOnDialogue && u.intent === "dialogue";
  const names = Object.fromEntries([...scene, ...linkedIds, ...stubs].map((id) => [id, nameOf(db, id)]));
  const planMeta = { input, understanding: u, linked, scene, stubs, names, gameTime: gameTime(db) };
  if (!skipPlanner) {
    planner = buildContext(ctx, { role: "planner", input, understanding: u, sceneEntities: scene, linked: linkedIds, memories, stubs });
    ({ actions, note } = await tick("plan", () => plan(ctx, planner!, planMeta)));
  }
  resolution = resolvePlan(db, actions, { seed: seedFor(turnSeed, getHead(db), 0), permadeath: config.permadeath });
  const factRejections = await tick("check_facts", () => checkPlannedFacts(ctx, resolution));
  firstRejections = [...resolution.rejections, ...factRejections];
  if (firstRejections.length && planner) {
    const replanCtx = buildContext(ctx, { role: "planner", input, understanding: u, sceneEntities: scene, linked: linkedIds, memories, stubs, rejections: firstRejections });
    const second = await tick("replan", () => plan(ctx, replanCtx, { ...planMeta, rejections: firstRejections, previous: actions }));
    actions = second.actions;
    note = second.note || note;
    resolution = resolvePlan(db, actions, { seed: seedFor(turnSeed, getHead(db), 1), permadeath: config.permadeath });
    const again = await checkPlannedFacts(ctx, resolution);
    // Still invalid: drop those facts, with a note.
    if (again.length) {
      const bad = new Set(again.map((a) => a.action));
      resolution.memory = resolution.memory.filter((m) => m.kind !== "fact" || !bad.has(`record_fact(${m.fact.statement})`));
      resolution.rejections.push(...again);
    }
  }
  const dropped = resolution.rejections;

  // Step 6: narrate. Step 7: verify, regenerate once with the problems.
  const narrInput = {
    role: "narrator" as const,
    input,
    understanding: u,
    sceneEntities: scene,
    linked: linkedIds,
    memories,
    stubs,
    mechanics: resolution.mechanics,
    notes: resolution.notes,
    rejections: dropped,
    planNote: note,
    speaker,
  };
  // The narrator sees the world as it will be after this turn's changes. The state is
  // computed in a savepoint that is rolled back at once: no model call runs inside it,
  // so background memory writes and call logs are never caught in the rollback.
  const presentBefore = presentEntities(db);
  const after = <T>(fn: () => T): T => {
    db.exec("SAVEPOINT narrate");
    try {
      for (const e of resolution.events) applyEvent(db, e, 0, gameTime(db));
      return fn();
    } finally {
      db.exec("ROLLBACK TO narrate");
      db.exec("RELEASE narrate");
    }
  };
  const { narrator, post } = after(() => ({ narrator: buildContext(ctx, narrInput), post: postState(ctx) }));
  const presentAfter = post.present.map((p) => p.id);
  const narrMeta = { input, understanding: u, mechanics: resolution.mechanics, notes: resolution.notes, scene, speaker, rejections: dropped };
  let prose = await tick("narrate", () => ctx.llm.text("narrator", "narrate", narrator.messages, narrMeta));
  let problems: string[] = [];
  let regenerated = false;
  if (config.components.verify) {
    problems = await tick("verify", async () => [...codeChecks(prose, narrator, memories, resolution, post), ...(await verifyProse(ctx, prose, resolution, memories, post))]);
    if (problems.length) {
      regenerated = true;
      const again = after(() => buildContext(ctx, { ...narrInput, feedback: problems }));
      prose = await tick("renarrate", () => ctx.llm.text("narrator", "narrate", again.messages, { ...narrMeta, feedback: problems }));
    }
  }

  if (hooks.editProse) prose = hooks.editProse(prose);

  // Step 8: commit.
  const outcome: TurnOutcome = {
    mechanics: resolution.mechanics,
    notes: resolution.notes,
    rejections: dropped,
    // Who witnessed the turn: everyone present before or after it.
    present: [...new Set([...presentBefore, ...presentAfter])],
    sceneEntities: scene,
    linked: linkedIds,
    sceneEnded: resolution.sceneBreak,
    checks: resolution.checks,
    contextKeys: [...new Set([...(planner?.includedKeys ?? []), ...narrator.includedKeys])],
    created: resolution.created,
  };
  const committed = await tick("commit", async () =>
    commitTurn(db, config, { input, intent: u, plan: actions, outcome: outcome as any, prose, resolution }),
  );

  // Step 9: remember, in the background.
  hooks.remember(committed.turn, committed.factIds, committed.origin);

  return {
    turn: committed.turn,
    prose,
    ooc: false,
    understanding: u,
    linked,
    mechanics: resolution.mechanics,
    notes: resolution.notes,
    rejections: firstRejections,
    dropped,
    plan: actions,
    planner,
    narrator,
    memories,
    retrieval: retrievalDebug,
    verification: { problems, regenerated },
    timings,
    state: hardStateLine(db),
  };
}

export function currentOrigin(ctx: Ctx): Origin {
  return { segment: headSegment(ctx.db), turn: getHead(ctx.db), gameTime: gameTime(ctx.db) };
}
