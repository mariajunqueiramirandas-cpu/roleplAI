#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { loadConfig, type DeepPartial, type Config } from "./config.ts";
import { Game, makeProvider } from "./game.ts";
import { LLM } from "./llm/client.ts";
import { reembedStale } from "./memory/vectors.ts";
import { getEntity } from "./state/read.ts";
import { formatTime } from "./util.ts";

const HELP = `roleplAI — a role-playing game run by AI, with a real game underneath.

Usage:
  roleplai new <campaign.db> --premise "..." --character "..." [--mock] [--permadeath]
  roleplai play <campaign.db> [--mock] [--debug]
  roleplai models                      check role models against OpenRouter's catalog
  roleplai eval [campaign.json ...] [--mock] [--ablate graph,rerank,...] [--out dir]
  roleplai bench <longmemeval|locomo> <data.json> [--mock] [--limit n]
  roleplai reembed <campaign.db>       re-embed memories after changing the embed model

In play:
  /status /history /undo [n] /rewind <turn> /save <name> /load <name> /slots /branches
  /pref <key> <value> /cost /debug /consolidate /help /quit
  Anything else is your character's action or speech. Start with (( for out-of-character.

Environment: OPENROUTER_API_KEY (required unless --mock), ROLEPLAI_PROVIDER=mock|openrouter.`;

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["mock", "debug", "permadeath"].includes(k)) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function overrides(flags: Record<string, string | boolean>): DeepPartial<Config> {
  const o: DeepPartial<Config> = {};
  if (flags.mock) o.provider = "mock";
  if (flags.permadeath) o.permadeath = true;
  return o;
}

async function prompt(q: string): Promise<string | null> {
  process.stdout.write(q);
  for await (const line of console) return line;
  return null;
}

/** Capabilities at startup: fail fast if a role's model lacks what the role needs. */
async function checkModels(config: Config) {
  if (config.provider === "mock") return;
  await new LLM(makeProvider(config), config).checkCapabilities({ strict: true });
}

async function play(path: string, flags: Record<string, string | boolean>) {
  if (!existsSync(path)) throw new Error(`${path} not found. Create it with: roleplai new ${path} --premise ... --character ...`);
  const game = Game.open(path, { config: overrides(flags) });
  if (game.ctx.config.provider !== "mock") await game.llm.checkCapabilities({ strict: true });
  let debug = !!flags.debug;
  console.log(game.status());
  const last = game.history(1)[0];
  if (last) console.log(`\n${last.prose}\n`);
  while (true) {
    const line = await prompt("\n> ");
    if (line == null) break;
    const input = line.trim();
    if (!input) continue;
    try {
      if (input.startsWith("/")) {
        const [cmd, ...rest] = input.slice(1).split(/\s+/);
        const arg = rest.join(" ");
        switch (cmd) {
          case "quit":
          case "exit":
            await game.idle();
            game.close();
            return;
          case "help":
            console.log(HELP);
            break;
          case "status":
            console.log(game.status());
            break;
          case "history":
            for (const t of game.history(Number(arg) || 10)) console.log(`T${t.id} [${formatTime(t.game_time)}] > ${t.input}\n${t.prose}\n`);
            break;
          case "undo":
            console.log(`Back at turn ${await game.undo(Number(arg) || 1)}.\n${game.status()}`);
            break;
          case "rewind":
            await game.rewind(Number(arg));
            console.log(`Rewound to turn ${arg}. Acting now starts a new branch.\n${game.status()}`);
            break;
          case "save":
            game.save(arg || "quicksave");
            console.log(`Saved '${arg || "quicksave"}' at turn ${game.head}.`);
            break;
          case "load":
            await game.load(arg || "quicksave");
            console.log(game.status());
            break;
          case "slots":
            for (const s of game.slots()) console.log(`${s.name}: turn ${s.turn} (${s.created_at})`);
            break;
          case "branches":
            for (const b of game.branches()) console.log(`segment ${b.segment}${b.parent ? ` (from segment ${b.parent} at T${b.fork_turn})` : ""}: ${b.turns} turns, tip T${b.tip}`);
            break;
          case "pref": {
            const [k, ...v] = rest;
            game.setPreference(k, v.join(" "));
            console.log(`Preference ${k} = ${v.join(" ")}`);
            break;
          }
          case "cost":
            console.table(game.costSummary());
            break;
          case "debug":
            debug = !debug;
            console.log(`debug ${debug ? "on" : "off"}`);
            break;
          case "consolidate":
            console.log(await game.consolidateNow());
            break;
          default:
            console.log(`Unknown command /${cmd}. /help lists them.`);
        }
        continue;
      }
      const r = await game.play(input);
      console.log(`\n${r.prose}`);
      if (debug) {
        console.log(`\n· intent ${r.understanding.intent} · linked ${JSON.stringify(r.linked)}`);
        for (const m of r.mechanics) console.log(`· ${m}`);
        for (const n of r.notes) console.log(`· note: ${n}`);
        for (const x of r.rejections) console.log(`· rejected: ${x.action} — ${x.reason}`);
        if (r.verification.problems.length) console.log(`· verifier: ${r.verification.problems.join(" | ")} (regenerated)`);
        console.log(`· context ${r.narrator?.tokens ?? 0}/${r.narrator?.budget ?? 0} tokens · ${JSON.stringify(r.timings)}`);
      }
      if (!r.ooc) console.log(`\n[${r.state}]`);
    } catch (e) {
      console.error(`! ${(e as Error).message}`);
    }
  }
  await game.idle();
  game.close();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  switch (cmd) {
    case "new": {
      const path = pos[0];
      if (!path || !flags.premise || !flags.character) throw new Error('Usage: roleplai new <campaign.db> --premise "..." --character "..."');
      await checkModels(loadConfig(overrides(flags)));
      console.log("Generating the world…");
      const { game, world } = await Game.create(path, { premise: String(flags.premise), character: String(flags.character) }, { config: overrides(flags) });
      console.log(`\n${world.frame.title}\n${world.frame.summary}\n\n${game.status()}\n\n${world.start.scene}`);
      if (world.consistency.problems.length) console.log(`\n(consistency pass fixed ${world.consistency.problems.length} problem(s))`);
      game.close();
      break;
    }
    case "play":
      await play(pos[0], flags);
      break;
    case "models": {
      const config = loadConfig(overrides(flags));
      const llm = new LLM(makeProvider(config), config);
      const problems = await llm.checkCapabilities();
      for (const r of Object.keys(config.roles) as (keyof Config["roles"])[]) console.log(`${r.padEnd(10)} ${config.roles[r].model} (context ${llm.contextLength(r) || "?"})`);
      console.log(problems.length ? `\nProblems:\n- ${problems.join("\n- ")}` : "\nAll role models look capable.");
      if (problems.length) process.exitCode = 1;
      break;
    }
    case "eval": {
      const { runEvalCli } = await import("./eval/runner.ts");
      await runEvalCli(pos, flags);
      break;
    }
    case "bench": {
      const { runBenchCli } = await import("./eval/benchmarks.ts");
      await runBenchCli(pos, flags);
      break;
    }
    case "reembed": {
      const game = Game.open(pos[0], { config: overrides(flags) });
      const n = await reembedStale(game.db, game.llm, (type, item) => {
        if (type === "fact") return (game.db.query("SELECT statement FROM facts WHERE id = ?").get(Number(item)) as any)?.statement ?? null;
        if (type === "episode") return (game.db.query("SELECT summary FROM episodes WHERE id = ?").get(Number(item)) as any)?.summary ?? null;
        const e = getEntity(game.db, item);
        return e ? `${e.name} (${e.kind}): ${e.profile || e.description}` : null;
      });
      console.log(`Re-embedded ${n} item(s).`);
      game.close();
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
