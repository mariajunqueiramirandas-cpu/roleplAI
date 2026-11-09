import type { Ctx } from "../ctx.ts";
import type { DB } from "../db/db.ts";
import { getMeta } from "../db/db.ts";
import { getHead } from "../db/lineage.ts";
import type { ChatMessage, ContentPart } from "../llm/types.ts";
import { isBeing, isPlace } from "../memory/entities.ts";
import { recentTurns, sceneTurns, type TurnRow } from "../memory/episodes.ts";
import { preferencesText } from "../memory/preferences.ts";
import { storySoFar } from "../memory/summaries.ts";
import { knownTo, memoryTag, type Scored } from "../retrieval/retrieve.ts";
import type { Rejection } from "../state/engine.ts";
import {
  activeThreads,
  currentScene,
  describeStateBlock,
  effectiveMax,
  entitiesAt,
  gameTime,
  getEntity,
  getStat,
  nameOf,
  statsOf,
  statusesOf,
} from "../state/read.ts";
import { formatTime, json, PLAYER, truncate } from "../util.ts";
import { NARRATOR_SYSTEM, PLANNER_SYSTEM } from "./prompts.ts";
import { estimateTokens, fitText, summaryOf } from "./tokens.ts";

export interface Understanding {
  intent: "action" | "dialogue" | "question" | "ooc";
  mentions: string[];
  target?: string | null;
  refersToPast: boolean;
  queries: string[];
}

export interface BuildInput {
  role: "planner" | "narrator";
  input: string;
  understanding: Understanding;
  sceneEntities: string[];
  linked: string[];
  memories: Scored[];
  stubs: string[];
  mechanics?: string[];
  notes?: string[];
  rejections?: Rejection[];
  planNote?: string;
  /** NPC currently speaking: narrator facts are limited to what they know. */
  speaker?: string | null;
  feedback?: string[];
}

export interface BuiltContext {
  messages: ChatMessage[];
  sections: { name: string; tokens: number }[];
  includedKeys: string[];
  tokens: number;
  budget: number;
  /** The full prompt as plain text (evals check what made it in). */
  text: string;
}

/** The current location, places nearby, and everyone present. Lookups, no search. */
export function sceneBlock(db: DB, role: "planner" | "narrator", stubs: string[]): string {
  const p = getEntity(db, PLAYER);
  const loc = p?.location ? getEntity(db, p.location) : null;
  const lines: string[] = [];
  if (loc) {
    lines.push(`Location: ${loc.name} [${loc.id}]${loc.stub ? " (STUB: fill in its details)" : ""} — ${loc.profile || loc.description || "(no description yet)"}`);
    const near = db
      .query(
        `SELECT id, name, stub FROM p_entities WHERE merged_into IS NULL AND id != ? AND
           ((location IS NOT NULL AND location = ?) OR location = ? OR id = ?)
         ORDER BY name LIMIT 30`,
      )
      .all(loc.id, loc.location ?? "", loc.id, loc.location ?? "") as { id: string; name: string; stub: number }[];
    const places = near.filter((n) => isPlace(getEntity(db, n.id)?.kind ?? ""));
    if (places.length) lines.push(`Nearby places: ${places.map((n) => `${n.name} [${n.id}]${n.stub ? " (stub)" : ""}`).join(", ")}`);
  }
  const present = loc ? entitiesAt(db, loc.id).filter((e) => e.id !== PLAYER) : [];
  const beings = present.filter((e) => isBeing(e.kind));
  if (beings.length) {
    lines.push("Present:");
    for (const e of beings) {
      const bits: string[] = [`${e.name} [${e.id}] (${e.kind})`];
      if (!e.alive) bits.push("DEAD");
      if (e.stub || stubs.includes(e.id)) bits.push("STUB: fill in details");
      const hp = getStat(db, e.id, "hp");
      if (hp) bits.push(`HP ${hp.value}/${effectiveMax(db, e.id, "hp") ?? hp.max}`);
      const sts = statusesOf(db, e.id);
      if (sts.length) bits.push(`statuses: ${sts.map((s) => s.label).join("; ")}`);
      const attitude = statsOf(db, e.id).filter((s) => s.toward === PLAYER);
      if (attitude.length) bits.push(`toward you: ${attitude.map((s) => `${s.name} ${s.value}${s.max != null ? `/${s.max}` : ""}`).join(", ")}`);
      const other = statsOf(db, e.id).filter((s) => s.category === "custom" && s.toward !== PLAYER);
      if (other.length && role === "planner") bits.push(`stats: ${other.map((s) => `${s.name}${s.toward ? `→${nameOf(db, s.toward)}` : ""} ${s.value}`).join(", ")}`);
      const desc = e.profile || e.description;
      lines.push(`- ${bits.join(" · ")}${desc ? ` — ${truncate(desc, 300)}` : ""}`);
    }
  } else lines.push("Present: nobody else.");
  const items = present.filter((e) => /item|object|weapon/.test(e.kind));
  if (items.length) lines.push(`Things here: ${items.map((i) => `${i.name} [${i.id}]`).join(", ")}`);
  const stubLines = stubs.filter((s) => !present.some((p) => p.id === s) && s !== loc?.id);
  for (const s of stubLines) {
    const e = getEntity(db, s);
    if (e) lines.push(`STUB to fill now: ${e.name} [${e.id}] (${e.kind}) — ${e.description || "named only"}`);
  }
  return lines.join("\n");
}

function threadsBlock(db: DB, role: "planner" | "narrator", scene: string[], staleAfter: number): string {
  const head = getHead(db);
  const ts = activeThreads(db).filter((t) => role === "planner" || !t.hidden);
  const rel = ts
    .map((t) => ({ t, hit: json<string[]>(t.entities, []).some((e) => scene.includes(e)) }))
    .sort((a, b) => Number(b.hit) - Number(a.hit) || b.t.updated_turn - a.t.updated_turn)
    .slice(0, 12);
  if (!rel.length) return "";
  return rel
    .map(({ t }) => {
      const dormant = role === "planner" && head - t.updated_turn >= staleAfter ? ` [DORMANT for ${head - t.updated_turn} turns: consider bringing it back]` : "";
      return `- [${t.id}] ${t.kind}: ${t.title} (${t.status})${t.hidden ? " [HIDDEN from player]" : ""}${dormant}${t.summary ? ` — ${t.summary}` : ""}`;
    })
    .join("\n");
}

function turnText(t: TurnRow): string {
  return `[T${t.id} · ${formatTime(t.game_time)}]\nPlayer: ${t.input}\nGM: ${t.prose}`;
}

export function buildContext(ctx: Ctx, b: BuildInput): BuiltContext {
  const { db, config, llm } = ctx;
  const cpt = llm.charsPerToken(b.role);
  const tok = (s: string) => estimateTokens(s, cpt);
  const roleCfg = config.roles[b.role];
  const ctxLen = llm.contextLength(b.role);
  const budget = Math.max(2000, Math.min(config.contextBudget, ctxLen ? ctxLen * 0.8 - (roleCfg.maxTokens ?? 1000) : Infinity));

  // ── must-haves ──
  const system = b.role === "planner" ? PLANNER_SYSTEM : NARRATOR_SYSTEM;
  const prefs = preferencesText(db);
  const rulesPart = system + (prefs ? `\n\nPLAYER PREFERENCES\n${prefs}` : "");
  const hard = `HARD STATE (authoritative)\n${describeStateBlock(db, PLAYER)}`;
  const mech =
    b.role === "narrator"
      ? [
          "RESOLVED OUTCOME (follow exactly)",
          ...(b.mechanics?.length ? b.mechanics.map((m) => `- ${m}`) : ["- No mechanical changes this turn."]),
          ...(b.notes?.length ? ["Notes:", ...b.notes.map((n) => `- ${n}`)] : []),
          ...(b.rejections?.length
            ? ["These attempted changes did NOT happen (the state did not allow them):", ...b.rejections.map((r) => `- ${r.reason}`)]
            : []),
          ...(b.planNote ? [`Planner's intent: ${b.planNote}`] : []),
        ].join("\n")
      : b.rejections?.length
        ? ["YOUR PREVIOUS PLAN HAD INVALID CHANGES. Here is the truth; plan again and work with it:", ...b.rejections.map((r) => `- ${r.action}: ${r.reason}`)].join("\n")
        : "";
  const feedback = b.feedback?.length ? `PROBLEMS WITH YOUR LAST DRAFT (fix all of them):\n${b.feedback.map((f) => `- ${f}`).join("\n")}` : "";
  const input = `PLAYER INPUT (${b.understanding.intent}${b.understanding.target ? ` to ${nameOf(db, b.understanding.target)}` : ""})\n${b.input}`;
  const recent = recentTurns(db, config.recentTurns);
  const must = recent.slice(-config.mustHaveRecentTurns);
  const older = recent.slice(0, -config.mustHaveRecentTurns);

  let used = tok(rulesPart) + tok(hard) + tok(mech) + tok(input) + tok(feedback) + must.reduce((s, t) => s + tok(turnText(t)), 0);
  const sections: { name: string; tokens: number }[] = [
    { name: "rules", tokens: tok(rulesPart) },
    { name: "hard_state", tokens: tok(hard) },
    { name: "mechanics", tokens: tok(mech) },
    { name: "input", tokens: tok(input) },
  ];
  const take = (name: string, text: string, max: number, min = 0): string => {
    if (!text) return "";
    const room = Math.max(0, budget - used);
    const cap = Math.min(max, room);
    if (cap < Math.min(min, tok(text)) || cap <= 20) return "";
    const t = tok(text) <= cap ? text : fitText(text, cap, cpt);
    used += tok(t);
    sections.push({ name, tokens: tok(t) });
    return t;
  };

  // ── priority sections ──
  const frame = getMeta(db, "frame") ?? "";
  const background = getMeta(db, "background") ?? "";
  const canon = take("canon", frame ? `WORLD FRAME (canon)\n${frame}` : "", 2200, 200);
  const bg = take("background", background ? `PLAYER CHARACTER BACKGROUND\n${background}` : "", 700);
  const scene = take("scene", `SCENE · ${formatTime(gameTime(db))} · scene ${currentScene(db)}\n${sceneBlock(db, b.role, b.stubs)}`, 2500, 200);
  const threads = take("threads", (() => {
    const t = threadsBlock(db, b.role, b.sceneEntities, config.consolidation.staleThreadTurns);
    return t ? `ACTIVE THREADS\n${t}` : "";
  })(), 1200);
  const inScene = sceneTurns(db, currentScene(db)).filter((t) => !recent.some((r) => r.id === t.id));
  const sceneSoFar = take(
    "scene_summary",
    inScene.length ? `EARLIER IN THIS SCENE\n${inScene.map((t) => `- ${summaryOf(t.input, 20)} → ${summaryOf(t.prose, 30)}`).join("\n")}` : "",
    800,
  );
  const story = storySoFar(db);
  const storyText = take(
    "story_so_far",
    story.length ? `STORY SO FAR\n${story.map((s) => `- (${s.level}) ${s.text}`).join("\n")}` : "",
    2500,
  );

  // ── memories by score per token ──
  let memories = b.memories;
  if (b.role === "narrator" && b.speaker && b.speaker !== PLAYER) memories = knownTo(db, memories, b.speaker) as Scored[];
  if (b.role === "narrator") memories = memories.filter((m) => !m.secret || m.knownBy.includes(PLAYER) || m.entities.some((e) => b.sceneEntities.includes(e)));
  const memLines: { key: string; line: string; score: number }[] = [];
  const reserveOlder = older.reduce((s, t) => s + tok(turnText(t)), 0);
  const ranked = [...memories].sort((a, c) => c.score / tok(c.text) - a.score / tok(a.text));
  for (const m of ranked) {
    const full = `${memoryTag(db, m)} ${m.text}`;
    const roomForMem = budget - used - reserveOlder;
    if (tok(full) <= roomForMem) {
      memLines.push({ key: m.key, line: full, score: m.score });
      used += tok(full);
    } else {
      const short = `${memoryTag(db, m)} ${summaryOf(m.text)}`;
      if (tok(short) <= roomForMem) {
        memLines.push({ key: m.key, line: short, score: m.score });
        used += tok(short);
      }
    }
  }
  memLines.sort((a, c) => c.score - a.score);
  const memText = memLines.length ? `RELEVANT MEMORIES\n${memLines.map((m) => m.line).join("\n")}` : "";
  sections.push({ name: "memories", tokens: tok(memText) });

  const olderText: string[] = [];
  for (const t of older) {
    const s = turnText(t);
    if (tok(s) <= budget - used) {
      olderText.push(s);
      used += tok(s);
    } else {
      const short = `[T${t.id}] Player: ${summaryOf(t.input)} GM: ${summaryOf(t.prose)}`;
      if (tok(short) <= budget - used) {
        olderText.push(short);
        used += tok(short);
      }
    }
  }
  const recentText = [...olderText, ...must.map(turnText)];
  sections.push({ name: "recent_turns", tokens: recentText.reduce((s, t) => s + tok(t), 0) });

  // ── layout: most stable first (cacheable), most important last ──
  const sys: ContentPart[] = [{ type: "text", text: rulesPart, cache: true }];
  if (canon || bg) sys.push({ type: "text", text: [canon, bg].filter(Boolean).join("\n\n"), cache: true });
  if (storyText) sys.push({ type: "text", text: storyText, cache: true });
  const userParts = [
    scene,
    threads,
    sceneSoFar,
    memText,
    hard,
    mech,
    recentText.length ? `RECENT TURNS (word for word)\n${recentText.join("\n\n")}` : "",
    feedback,
    input,
    b.role === "planner"
      ? "Plan this turn now with tool calls (or none if nothing mechanical happens)."
      : "Write the prose for this turn now.",
  ].filter(Boolean);
  const messages: ChatMessage[] = [
    { role: "system", content: sys },
    { role: "user", content: userParts.join("\n\n") },
  ];
  const text = [...sys.map((s) => s.text), ...userParts].join("\n\n");
  return { messages, sections, includedKeys: memLines.map((m) => m.key), tokens: used, budget, text };
}
