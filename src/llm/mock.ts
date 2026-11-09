import { DEFAULT_CONFIG, ROLES } from "../config.ts";
import { describeAction } from "../state/engine.ts";
import { hashString, norm, words } from "../util.ts";
import { sampleWorld } from "../world/sample.ts";
import type { ChatRequest, ChatResponse, ModelInfo, Provider, ToolCall, Usage } from "./types.ts";
import { textOf } from "./types.ts";

/**
 * A deterministic offline provider. It lets the whole system — pipeline, branches,
 * memory, evals — run and be tested without a key or network. Embeddings are hashed
 * bags of words; reranking is word overlap; the "models" follow simple rules.
 *
 * It is a test double, not a game master: real play uses OpenRouter.
 */

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };

function stem(w: string) {
  return w.replace(/(ing|ed|es|s)$/, "").slice(0, 12) || w;
}

export function hashEmbed(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0);
  const ws = words(text).map(stem);
  for (const w of ws) {
    const h = hashString(w);
    v[h % dims] += 1;
    v[(h >>> 11) % dims] += (h & 1 ? 1 : -1) * 0.5;
  }
  for (let i = 0; i + 1 < ws.length; i++) v[hashString(`${ws[i]} ${ws[i + 1]}`) % dims] += 0.5;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function overlapScore(q: string, d: string): number {
  const qw = new Set(words(q).map(stem));
  const dw = words(d).map(stem);
  if (!qw.size || !dw.length) return 0;
  const hits = dw.filter((w) => qw.has(w)).length;
  return Math.min(1, hits / Math.sqrt(dw.length * qw.size) * 1.2);
}

const usage = (req: ChatRequest | null, out = ""): Usage => ({
  promptTokens: req ? Math.ceil(req.messages.reduce((s, m) => s + textOf(m.content).length, 0) / 3.6) : 0,
  completionTokens: Math.ceil(out.length / 3.6),
  cachedTokens: 0,
  cost: 0,
});

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toSecondPerson(input: string): string {
  let s = input.trim().replace(/^["“](.*)["”]$/, "$1");
  s = s.replace(/^I\b/, "You").replace(/\bI\b/g, "you").replace(/\bmy\b/gi, "your").replace(/\bme\b/gi, "you").replace(/\bam\b/g, "are");
  if (!/^you\b/i.test(s)) s = `You ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// ── the mock game master ────────────────────────────────────────────────────

type Meta = Record<string, any>;

function plannerCalls(meta: Meta): ToolCall[] {
  const input: string = meta.input ?? "";
  const low = input.toLowerCase();
  const linked: Record<string, string | null> = meta.linked ?? {};
  const names: Record<string, string> = meta.names ?? {};
  const ids = Object.values(linked).filter((x): x is string => !!x && x !== "player");
  const npc = ids.find((i) => i.startsWith("npc_")) ?? (meta.scene ?? []).find((s: string) => s.startsWith("npc_"));
  const place = ids.find((i) => i.startsWith("place_"));
  const calls: { name: string; args: any }[] = [];
  const add = (name: string, args: any) => calls.push({ name, args });

  if (/\b(go|walk|travel|head|return|enter)\b/.test(low) && place) {
    add("move", { entity: "player", to: place });
    add("advance_time", { minutes: /\btravel|journey\b/.test(low) ? 240 : 20 });
  }
  if (/\b(attack|hit|strike|fight|stab|punch|kill|slay)\b/.test(low) && npc) {
    const kill = /\b(kill|slay)\b/.test(low);
    add("check", {
      actor: "player",
      description: `Attack ${names[npc] ?? npc}`,
      attribute: "body",
      traits: [],
      difficulty: "medium",
      onSuccess: [
        { tool: "adjust", entity: npc, stat: "hp", direction: "down", severity: kill ? "massive" : "moderate", reason: "struck by the player" },
        ...(kill ? [{ tool: "set_alive", entity: npc, alive: false, cause: "slain by the player" }] : []),
      ],
      onFailure: [{ tool: "adjust", entity: "player", stat: "hp", direction: "down", severity: "minor", reason: "counterattack" }],
    });
  }
  const buy = low.match(/\bbuy (?:a |an |the )?([a-z' -]+?) (?:for|from) .*?(\d+) gold/) ?? low.match(/\bbuy (?:a |an |the )?([a-z' -]+?) for (\d+) gold/);
  if (buy) {
    add("transfer", { from: "player", to: npc ?? "world", item: "gold", quantity: Number(buy[2]), reason: `buying ${buy[1]}` });
    add("transfer", { from: npc && /\bfrom\b/.test(low) ? "world" : "world", to: "player", item: buy[1].trim(), quantity: 1, reason: "bought" });
  }
  const give = low.match(/\bgive (\d+) gold\b/);
  if (give && npc) add("transfer", { from: "player", to: npc, item: "gold", quantity: Number(give[1]) });
  const pay = low.match(/\bpay (?:\w+ )?(\d+) gold\b/);
  if (pay && !give && !buy) add("transfer", { from: "player", to: npc ?? "world", item: "gold", quantity: Number(pay[1]) });
  if (/\b(persuade|convince|charm|intimidate|bargain|haggle)\b/.test(low) && npc) {
    add("check", {
      actor: "player",
      description: `Persuade ${names[npc] ?? npc}`,
      attribute: "presence",
      traits: [],
      difficulty: "hard",
      onSuccess: [{ tool: "adjust", entity: npc, stat: "trust", toward: "player", direction: "up", amount: 1, reason: "persuaded" }],
      onFailure: [],
    });
  }
  if (/\b(sneak|hide|climb|jump|dodge|pick the lock)\b/.test(low)) {
    add("check", { actor: "player", description: "Move unseen", attribute: "agility", traits: [], difficulty: "medium", onSuccess: [], onFailure: [] });
  }
  if (/\b(search|investigate|look for)\b/.test(low)) {
    add("check", {
      actor: "player",
      description: "Search",
      attribute: "mind",
      traits: [],
      difficulty: "medium",
      onSuccess: [{ tool: "transfer", from: "world", to: "player", item: "gold", reward: "small", reason: "found coins" }],
      onFailure: [],
    });
  }
  if (/\b(rest|sleep|camp)\b/.test(low)) {
    add("advance_time", { span: "night" });
    add("adjust", { entity: "player", stat: "hp", direction: "up", severity: "major", reason: "rest" });
  } else if (/\bwait\b/.test(low)) add("advance_time", { span: "hour" });
  if (/\b(cast|spell)\b/.test(low)) add("adjust", { entity: "player", stat: "mana", direction: "down", severity: "minor", reason: "spell" });
  if (/\bdrink\b.*\bpotion\b|\bheal\b/.test(low)) add("adjust", { entity: "player", stat: "hp", direction: "up", severity: "moderate", reason: "healing" });
  const promise = input.match(/\b(?:promise|agree|swear) to ([^.!?]+)/i);
  if (promise) add("thread", { status: "open", kind: "promise", title: promise[1].trim().slice(0, 60), summary: input, entities: npc ? [npc] : [] });
  if (/\bend (the )?scene\b/.test(low)) add("end_scene", { reason: "player ended the scene" });
  for (const s of meta.stubs ?? []) {
    add("record_fact", { subject: s, statement: `${names[s] ?? s} is quiet, weathered and older than it looks.`, importance: 4, knownBy: [] });
  }

  let out = calls;
  if (meta.rejections?.length) {
    const bad = new Set((meta.rejections as { action: string }[]).map((r) => r.action));
    out = calls.filter((c) => !bad.has(describeAction({ tool: c.name, ...c.args } as any)));
    // No payment, no purchase.
    if (buy && out.length < calls.length) out = out.filter((c) => !(c.name === "transfer" && c.args.reason === "bought"));
    // For nested checks, drop only the rejected inner change.
    out = out.map((c) =>
      c.name === "check"
        ? {
            ...c,
            args: {
              ...c.args,
              onSuccess: c.args.onSuccess.filter((x: any) => !bad.has(describeAction(x))),
              onFailure: c.args.onFailure.filter((x: any) => !bad.has(describeAction(x))),
            },
          }
        : c,
    );
  }
  return out.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
}

function narrate(meta: Meta): string {
  const input: string = meta.input ?? "";
  const parts: string[] = [toSecondPerson(input)];
  for (const m of (meta.mechanics ?? []) as string[]) {
    const s = m.match(/→ (SUCCESS|FAILURE)/);
    if (s) parts.push(s[1] === "SUCCESS" ? "It works." : "It doesn't work.");
  }
  if (meta.understanding?.intent === "dialogue" && meta.speaker) parts.push("They consider your words.");
  if ((meta.notes ?? []).some((n: string) => n.includes("DOWNED"))) parts.push("Darkness takes you, and you wake later, hurt but alive.");
  return parts.join(" ");
}

function extract(meta: Meta) {
  const names: Record<string, string> = meta.names ?? {};
  const known = Object.entries(names);
  const prose: string = meta.prose ?? "";
  const entities: any[] = [];
  const facts: any[] = [];
  const seen = new Set<string>();
  for (const sent of sentences(prose)) {
    if (/^(It works|It doesn't work|They consider|Darkness takes)/.test(sent)) continue;
    const mentioned: string[] = [];
    const playerFirst = words(names.player ?? "")[0];
    if (/^You\b/.test(sent) || (playerFirst && words(sent)[0] === playerFirst)) mentioned.push("player");
    for (const [id, name] of known) {
      if (id === "player") continue;
      const first = words(name)[0];
      if (first && words(sent).includes(first)) mentioned.push(id);
    }
    // New capitalised names after "named"/"called".
    for (const m of sent.matchAll(/\b(?:named|called) ([A-Z][\w'’]+(?: [A-Z][\w'’]+)?)/g)) {
      const name = m[1];
      if (!known.some(([, n]) => norm(n) === norm(name)) && !seen.has(norm(name))) {
        entities.push({ mention: name, id: null, kind: /\b(village|town|tower|keep|inn|forest)\b/i.test(sent) ? "place" : "npc", name, description: sent });
        seen.add(norm(name));
      }
      mentioned.push(name);
    }
    for (const id of mentioned) if (names[id] && !seen.has(id)) {
      entities.push({ mention: names[id], id, kind: id.split("_")[0], name: names[id], description: "" });
      seen.add(id);
    }
    if (!mentioned.length) continue;
    const secret = /\bwhisper/i.test(sent);
    facts.push({
      subject: mentioned[0],
      predicate: "",
      statement: sent.replace(/^You\b/, "The player"),
      importance: /\b(promise|secret|kill|dead|died|owe|debt)\b/i.test(sent) ? 7 : 5,
      secret: false,
      knownBy: secret ? ["player", mentioned[0]] : null,
    });
  }
  return { entities, facts, threads: [], importance: facts.length ? 5 : 2 };
}

function numberIn(s: string): number | null {
  const m = s.toLowerCase().match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\b/);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUM[m[1]];
}

function labelPair(a: string, b: string): string {
  const aw = new Set(words(a).map(stem));
  const bw = words(b).map(stem);
  const inter = bw.filter((w) => aw.has(w)).length;
  const jac = inter / (new Set([...aw, ...bw]).size || 1);
  const na = numberIn(a), nb = numberIn(b);
  if (na != null && nb != null && na !== nb && jac >= 0.3) return /\b(now|rebuilt|added|lost|destroyed|after)\b/i.test(a) ? "update" : "contradiction";
  if (/\b(is dead|died)\b/i.test(b) && /\b(alive|says|walks|smiles)\b/i.test(a) && jac >= 0.2) return "contradiction";
  const la = a.match(/\bis (?:at|in) (?:the )?([^.,;]+)/i), lb = b.match(/\bis (?:at|in) (?:the )?([^.,;]+)/i);
  if (la && lb && norm(la[1]) !== norm(lb[1])) return /\b(now|moved|went)\b/i.test(a) ? "update" : "contradiction";
  if (norm(a) === norm(b) || jac >= 0.8) return "duplicate";
  if (/\b(now|no longer|moved|has become)\b/i.test(a) && inter >= 2) return "update";
  return "new_detail";
}

function structured(req: ChatRequest): unknown {
  const m = (req.meta ?? {}) as Meta;
  const task = req.task;
  if (task.startsWith("world_")) {
    const name = String(m.character ?? "").match(/\bnamed ([A-Z][a-z]+)/)?.[1] ?? "Ash";
    return (sampleWorld(name, m.character) as any)[task.slice(6)] ?? {};
  }
  switch (task) {
    case "understand": {
      const input: string = m.input ?? "";
      const dialogue = /^["“]|^(i )?(say|ask|tell|whisper|shout)\b/i.test(input.trim());
      const mentions = [...input.matchAll(/\b([A-Z][a-z'’]+(?: [A-Z][a-z'’]+)*)\b/g)].map((x) => x[1]).filter((x) => !/^(I|The|A|An|What|Who|Where|When|How|Why|Is|Do|Does)$/.test(x));
      for (const ph of input.matchAll(/\bthe (blacksmith|old smith|innkeeper|captain|tower|inn|smithy)\b/gi)) mentions.push(`the ${ph[1]}`);
      for (const pr of input.matchAll(/\b(her|him|she|he)\b/gi)) if (!mentions.length) mentions.push(pr[1]);
      return {
        intent: /^\(\(|^ooc/i.test(input) ? "ooc" : dialogue ? "dialogue" : /\?\s*$/.test(input) ? "question" : "action",
        mentions,
        target: dialogue ? (mentions[0] ?? null) : null,
        refersToPast: /\b(earlier|before|back then|last time|ago|remember|did .* say|what did)\b/i.test(input),
        queries: [],
      };
    }
    case "link":
      return { choice: m.candidates?.[0] ?? "none" };
    case "verify_prose":
      return { ok: true, problems: [] };
    case "contradiction":
      return { labels: (m.existing ?? []).map((e: { id: number; statement: string }) => ({ id: e.id, label: labelPair(m.new, e.statement) })) };
    case "extract":
      return extract(m);
    case "episode":
      return { summary: (m.turns ?? []).map((t: any) => toSecondPerson(t.input).replace(/^You\b/, "The player")).join(" ").slice(0, 600), importance: 4 };
    case "profile":
      return { profile: [m.description, ...(m.facts ?? []).slice(0, 4)].filter(Boolean).join(" ").slice(0, 500) };
    case "duplicate":
      return { same: (m.sim ?? 0) > 0.95 && (m.nameOverlap ?? 0) > 0, reason: "" };
    case "conflict":
      return { keep: "old", reason: "" };
    case "reflection":
      return { beliefs: [{ statement: `${m.name} has been thinking about the player since their last meetings.`, importance: 4 }] };
  }
  if (task.startsWith("summary_")) return { summary: (m.items ?? []).join(" ").slice(0, 900) };
  return {};
}

export class MockProvider implements Provider {
  name = "mock";

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const m = (req.meta ?? {}) as Meta;
    let content = "";
    let toolCalls: ToolCall[] = [];
    if (req.tools?.length) toolCalls = plannerCalls(m);
    else if (req.jsonSchema) content = JSON.stringify(structured(req));
    else if (req.task === "ooc") content = "(GM) The rules are simple: say what you do, and the dice decide what's uncertain.";
    else content = narrate(m);
    return { content, toolCalls, usage: usage(req, content), model: req.model, provider: "mock" };
  }

  async embed(_model: string, inputs: string[], dims: number) {
    return { vectors: inputs.map((t) => hashEmbed(t, dims)), usage: usage(null) };
  }

  async rerank(_model: string, query: string, docs: string[]) {
    return { results: docs.map((d, index) => ({ index, score: overlapScore(query, d) })), usage: usage(null) };
  }

  async models(): Promise<ModelInfo[]> {
    const ids = new Set<string>();
    for (const r of ROLES) {
      ids.add(DEFAULT_CONFIG.roles[r].model);
      for (const f of DEFAULT_CONFIG.roles[r].fallbacks ?? []) ids.add(f);
    }
    return [...ids].map((id) => ({ id, contextLength: 200_000, supportedParameters: ["tools", "response_format", "structured_outputs", "temperature"] }));
  }
}
