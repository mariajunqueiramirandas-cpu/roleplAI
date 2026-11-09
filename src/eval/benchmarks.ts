import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config, DeepPartial } from "../config.ts";
import { Game } from "../game.ts";
import { rememberTurn } from "../ingest/remember.ts";
import { retrieve } from "../retrieval/retrieve.ts";
import type { Resolution } from "../state/engine.ts";
import { gameTime } from "../state/read.ts";
import { commitTurn } from "../turn/commit.ts";
import type { GeneratedWorld } from "../world/generate.ts";
import { memoryTag } from "../retrieval/retrieve.ts";

/**
 * External sanity checks on long-conversation memory: LongMemEval and LoCoMo.
 * Each conversation is ingested as turns through the normal write path, then each
 * question is answered from retrieved memories and graded by the judge.
 */

interface Message {
  speaker: "user" | "other";
  text: string;
  time: number | null;
}
interface Item {
  id: string;
  type: string;
  sessions: Message[][];
  question: string;
  answer: string;
}

function minutes(date: string | undefined, origin: number | null): number | null {
  if (!date) return null;
  const t = Date.parse(date.replace(/\(.*?\)/g, "").replace(/ at /, " "));
  if (isNaN(t)) return null;
  return origin == null ? 0 : Math.max(0, Math.round((t - origin) / 60000));
}

export function parseLongMemEval(data: any[]): Item[] {
  return data.map((d) => {
    const origin = Date.parse(d.haystack_dates?.[0] ?? "") || null;
    return {
      id: d.question_id,
      type: d.question_type ?? "unknown",
      question: d.question,
      answer: String(d.answer),
      sessions: (d.haystack_sessions ?? []).map((s: any[], i: number) =>
        s.map((m) => ({ speaker: m.role === "user" ? "user" : "other", text: m.content, time: minutes(d.haystack_dates?.[i], origin) })),
      ),
    };
  });
}

export function parseLoCoMo(data: any[]): Item[] {
  const out: Item[] = [];
  for (const d of data) {
    const conv = d.conversation ?? {};
    const a = conv.speaker_a;
    const keys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).sort((x, y) => Number(x.split("_")[1]) - Number(y.split("_")[1]));
    const origin = Date.parse((conv[`${keys[0]}_date_time`] ?? "").replace(/ on /, " ")) || null;
    const sessions = keys.map((k) =>
      (conv[k] as any[]).map((m) => ({ speaker: (m.speaker === a ? "user" : "other") as Message["speaker"], text: m.text, time: minutes(conv[`${k}_date_time`]?.replace(/ on /, " "), origin) })),
    );
    for (const [i, q] of (d.qa ?? []).entries()) {
      if (q.answer == null) continue;
      out.push({ id: `${d.sample_id}-${i}`, type: `category_${q.category}`, question: q.question, answer: String(q.answer), sessions });
    }
  }
  return out;
}

function conversationWorld(): GeneratedWorld {
  return {
    frame: { title: "Conversation", genre: "conversation", tone: "plain", themes: ["memory"], rules: ["Everything said is remembered.", "Nothing is invented."], summary: "A long conversation between two people." },
    geography: { regions: [{ name: "Here", description: "Where the conversation happens.", starting: true, places: [] }, { name: "Elsewhere", description: "", starting: false, places: [] }] },
    factions: { factions: [] },
    history: { events: [], tensions: [] },
    npcs: { npcs: [{ name: "Companion", aliases: ["assistant", "the other speaker"], role: "the other speaker", description: "The person the user talks to.", location: "Here", goal: "to talk", faction: null, relationships: [], secrets: [], toughness: "minor" }] },
    start: { location: "Here", locationDescription: "A conversation.", scene: "", threads: [] },
    character: { name: "User", description: "The user.", attributes: { body: "average", agility: "average", mind: "average", presence: "average" }, traits: [{ label: "talkative", bonus: 1 }], wealth: "destitute", inventory: [], background: ["The user is having a long conversation.", "The user shares details about their life."] },
    consistency: { problems: [] },
  } as GeneratedWorld;
}

function plainResolution(from: number, to: number): Resolution {
  return {
    events: to > from ? [{ type: "time_set", from, to }] : [],
    mechanics: [],
    rejections: [],
    notes: [],
    memory: [],
    created: [],
    checks: [],
    sceneBreak: null,
    timeBefore: from,
    timeAfter: Math.max(from, to),
  };
}

const AnswerSchema = z.object({ answer: z.string() });
const GradeSchema = z.object({ correct: z.boolean() });

export async function runBenchmark(kind: "longmemeval" | "locomo", path: string, opts: { config?: DeepPartial<Config>; limit?: number } = {}) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const items = (kind === "longmemeval" ? parseLongMemEval(raw) : parseLoCoMo(raw)).slice(0, opts.limit ?? Infinity);
  const results: { id: string; type: string; correct: boolean | null; retrieved: boolean }[] = [];
  let cache: { key: Message[][]; game: Game } | null = null;
  for (const it of items) {
    if (!cache || cache.key !== it.sessions) {
      cache?.game.close();
      const { game } = await Game.create(":memory:", { premise: "conversation", character: "the user", fixed: conversationWorld() }, { config: { ...opts.config, components: { reflections: false } }, rngSeed: 1 });
      for (const s of it.sessions) {
        for (let i = 0; i < s.length; i++) {
          const userMsg = s[i].speaker === "user" ? s[i] : null;
          const reply = s[i].speaker === "user" ? s[i + 1] : s[i];
          if (userMsg) i++;
          const now = gameTime(game.db);
          const to = (userMsg ?? reply)?.time ?? now;
          const c = commitTurn(game.db, game.ctx.config, {
            input: userMsg?.text ?? "",
            intent: { intent: "dialogue" },
            plan: [],
            outcome: { mechanics: [], notes: [], rejections: [], present: ["player", "npc_companion"], sceneEntities: ["player", "npc_companion"], linked: [], sceneEnded: i >= s.length - 1 ? "session ended" : null, checks: [], contextKeys: [], created: [] },
            prose: reply?.text ?? "",
            resolution: plainResolution(now, to ?? now),
          });
          await rememberTurn(game.ctx, c.turn);
        }
      }
      cache = { key: it.sessions, game };
    }
    const g = cache.game;
    const mems = await retrieve(g.ctx, { queries: [it.question], sceneEntities: ["player"], linked: [], refersToPast: true, excludeTurns: [], limit: 30 });
    const context = mems.map((m) => `${memoryTag(g.db, m)} ${m.text}`).join("\n");
    const retrieved = context.toLowerCase().includes(it.answer.toLowerCase().slice(0, 40));
    let correct: boolean | null = null;
    if (g.ctx.config.provider !== "mock") {
      const a = await g.llm.structured("narrator", "bench_answer", [
        { role: "system", content: "Answer the question using only the memories. Be brief." },
        { role: "user", content: `MEMORIES\n${context}\n\nQUESTION: ${it.question}` },
      ], AnswerSchema, { fallback: { answer: "" } });
      const grade = await g.llm.structured("verifier", "judge", [
        { role: "system", content: "Grade the answer against the reference. Correct if it means the same thing." },
        { role: "user", content: `QUESTION: ${it.question}\nREFERENCE: ${it.answer}\nANSWER: ${a.answer}` },
      ], GradeSchema, { fallback: { correct: false } });
      correct = grade.correct;
    }
    results.push({ id: it.id, type: it.type, correct, retrieved });
  }
  cache?.game.close();
  const byType: Record<string, { n: number; correct: number; retrieved: number }> = {};
  for (const r of results) {
    const b = (byType[r.type] ??= { n: 0, correct: 0, retrieved: 0 });
    b.n++;
    if (r.correct) b.correct++;
    if (r.retrieved) b.retrieved++;
  }
  return { kind, n: results.length, byType, results };
}

export async function runBenchCli(pos: string[], flags: Record<string, string | boolean>) {
  const [kind, path] = pos;
  if ((kind !== "longmemeval" && kind !== "locomo") || !path) throw new Error("Usage: roleplai bench <longmemeval|locomo> <data.json> [--limit n] [--mock]");
  const r = await runBenchmark(kind, path, { config: flags.mock ? { provider: "mock" } : {}, limit: flags.limit ? Number(flags.limit) : undefined });
  console.log(JSON.stringify({ kind: r.kind, n: r.n, byType: r.byType }, null, 2));
}
