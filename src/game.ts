import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, type Config, type DeepPartial } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { getMeta, openDb, setMeta, type DB } from "./db/db.ts";
import { getHead, timelineTurnIds, VIS_TURN } from "./db/lineage.ts";
import { consolidate, reflect, type ConsolidationReport } from "./ingest/consolidate.ts";
import { rememberTurn, type RememberReport } from "./ingest/remember.ts";
import { LLM } from "./llm/client.ts";
import { MockProvider } from "./llm/mock.ts";
import { OpenRouterProvider } from "./llm/openrouter.ts";
import type { Provider } from "./llm/types.ts";
import type { Origin } from "./memory/entities.ts";
import { getTurn, unextractedTurns } from "./memory/episodes.ts";
import { getFacts } from "./memory/facts.ts";
import { setPreference } from "./memory/preferences.ts";
import { storeEmbeddings } from "./memory/vectors.ts";
import { rebuildProjections, switchTimeline } from "./state/projection.ts";
import { describeStateBlock, gameTime } from "./state/read.ts";
import { currentOrigin, runTurn, type TurnResult } from "./turn/pipeline.ts";
import { formatTime, hashString, json, now, PLAYER, Queue } from "./util.ts";
import { generateWorld, storeWorld, type GeneratedWorld, type WorldSeed } from "./world/generate.ts";

export interface GameOptions {
  config?: DeepPartial<Config>;
  provider?: Provider;
}

export function makeProvider(config: Config): Provider {
  return config.provider === "mock" ? new MockProvider() : new OpenRouterProvider();
}

export class Game {
  readonly ctx: Ctx;
  readonly memory = new Queue();
  readonly reports: RememberReport[] = [];
  readonly consolidations: ConsolidationReport[] = [];
  readonly errors: string[] = [];
  private failures = new Map<number, number>();

  private constructor(
    readonly path: string,
    db: DB,
    llm: LLM,
    config: Config,
  ) {
    this.ctx = { db, llm, config };
  }

  get db() {
    return this.ctx.db;
  }
  get llm() {
    return this.ctx.llm;
  }

  static open(path: string, opts: GameOptions = {}): Game {
    const config = loadConfig(opts.config);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = openDb(path, config.embedDims);
    const llm = new LLM(opts.provider ?? makeProvider(config), config).attach(db);
    const g = new Game(path, db, llm, config);
    if (getHead(db)) rebuildProjections(db);
    return g;
  }

  /** New campaign: generate the world (or use a fixed one) and store it as the genesis turn. */
  static async create(path: string, seed: WorldSeed, opts: GameOptions & { rngSeed?: number } = {}): Promise<{ game: Game; world: GeneratedWorld }> {
    if (path !== ":memory:" && existsSync(path)) throw new Error(`${path} already exists`);
    const g = Game.open(path, opts);
    setMeta(g.db, "seed", String(opts.rngSeed ?? hashString(`${seed.premise}|${seed.character}|${now()}`)));
    setMeta(g.db, "created_at", now());
    const world = await generateWorld(g.ctx, seed);
    await storeWorld(g.ctx, world, seed);
    return { game: g, world };
  }

  async play(input: string, opts: { editProse?: (prose: string) => string } = {}): Promise<TurnResult> {
    return runTurn(this.ctx, input, {
      editProse: opts.editProse,
      remember: (turn, factIds, origin) => this.queueRemember(turn, factIds, origin),
      waitForMemory: () => this.waitForMemory(),
      reflect: async (npcs) => {
        const o = currentOrigin(this.ctx);
        for (const n of npcs) await reflect(this.ctx, n, o).catch((e) => this.errors.push(`reflect ${n}: ${(e as Error).message}`));
      },
    });
  }

  private queueRemember(turn: number, factIds: number[], origin: Origin) {
    this.memory.push(async () => {
      try {
        const facts = getFacts(this.db, factIds);
        await storeEmbeddings(this.db, this.llm, facts.map((f) => ({ type: "fact" as const, item: f.id, text: f.statement })), origin).catch(() => undefined);
        const r = await rememberTurn(this.ctx, turn);
        this.reports.push(r);
        const t = getTurn(this.db, turn)!;
        const sceneEnded = !!json<any>(t.outcome, {}).sceneEnded;
        const n = timelineTurnIds(this.db).length;
        if (this.ctx.config.components.consolidation && (sceneEnded || n % this.ctx.config.consolidation.everyTurns === 0)) {
          this.consolidations.push(await consolidate(this.ctx, currentOrigin(this.ctx)));
        }
      } catch (e) {
        const f = (this.failures.get(turn) ?? 0) + 1;
        this.failures.set(turn, f);
        this.errors.push(`remember T${turn}: ${(e as Error).message}`);
        // Requeue once; after that, give up on this turn rather than block play.
        if (f < 2) this.queueRemember(turn, [], origin);
        else this.db.query("UPDATE turns SET extracted = -1 WHERE id = ?").run(turn);
      }
    });
  }

  private async waitForMemory() {
    for (let i = 0; i < 5 && unextractedTurns(this.db).length >= this.ctx.config.extractionLag; i++) await this.memory.idle();
  }

  /** Wait for all background memory work. */
  idle() {
    return this.memory.idle();
  }

  async consolidateNow() {
    await this.idle();
    const r = await consolidate(this.ctx, currentOrigin(this.ctx));
    this.consolidations.push(r);
    return r;
  }

  // ── timeline ──────────────────────────────────────────────────────────────

  get head() {
    return getHead(this.db);
  }

  async rewind(turn: number) {
    await this.idle();
    if (!getTurn(this.db, turn)) throw new Error(`No turn ${turn}`);
    switchTimeline(this.db, turn);
  }

  /** Undo n turns on the current timeline (never past the world's creation). */
  async undo(n = 1): Promise<number> {
    let t = this.head;
    for (let i = 0; i < n; i++) {
      const row = getTurn(this.db, t);
      if (!row?.parent) break;
      t = row.parent;
    }
    await this.rewind(t);
    return t;
  }

  save(name: string) {
    this.db.query("INSERT INTO slots(name, turn, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET turn = excluded.turn, created_at = excluded.created_at").run(name, this.head, now());
  }

  async load(name: string) {
    const r = this.db.query("SELECT turn FROM slots WHERE name = ?").get(name) as { turn: number } | null;
    if (!r) throw new Error(`No save slot '${name}'`);
    await this.rewind(r.turn);
  }

  slots() {
    return this.db.query("SELECT name, turn, created_at FROM slots ORDER BY created_at DESC").all() as { name: string; turn: number; created_at: string }[];
  }

  /** Branch tips: every segment's last turn. */
  branches() {
    return this.db
      .query(
        `SELECT s.id segment, s.parent, s.fork_turn, MAX(t.id) tip, COUNT(t.id) turns FROM segments s
         LEFT JOIN turns t ON t.segment = s.id GROUP BY s.id ORDER BY s.id`,
      )
      .all() as { segment: number; parent: number | null; fork_turn: number | null; tip: number; turns: number }[];
  }

  history(limit = 20) {
    return (
      this.db.query(`SELECT t.id, t.input, t.prose, t.game_time FROM turns t WHERE ${VIS_TURN} ORDER BY t.id DESC LIMIT ?`).all(limit) as {
        id: number;
        input: string;
        prose: string;
        game_time: number;
      }[]
    ).reverse();
  }

  setPreference(key: string, value: string) {
    setPreference(this.db, key, value);
  }

  status(): string {
    return `${getMeta(this.db, "title") ?? "Untitled"} · ${formatTime(gameTime(this.db))} · turn ${this.head}\n${describeStateBlock(this.db, PLAYER)}`;
  }

  costSummary() {
    return this.db
      .query(
        `SELECT role, COUNT(*) calls, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(tokens_cached) cached, ROUND(SUM(cost), 5) cost,
                ROUND(AVG(latency_ms)) ms, SUM(repaired) repaired, SUM(failed) failed FROM llm_calls GROUP BY role ORDER BY role`,
      )
      .all();
  }

  close() {
    this.db.close();
  }
}
