import type { DB } from "../db/db.ts";
import { addAlias, isBeing, isPlaceKind, newEntityId, resolveRef, type Origin } from "../memory/entities.ts";
import type { NewFact } from "../memory/facts.ts";
import { clamp, formatTime, GOLD, hashString, json, norm, PLAYER, rng, slug, WORLD } from "../util.ts";
import type { GameEvent } from "./events.ts";
import { applyEvent } from "./projection.ts";
import {
  currentScene,
  effectiveMax,
  effectsOf,
  entitiesAt,
  gameTime,
  getEntity,
  getStat,
  holding,
  level,
  nameOf,
  statusesOf,
  traitsOf,
} from "./read.ts";
import {
  baseMaxHp,
  baseMaxMana,
  levelScale,
  rewardAmount,
  SCENE_TIME_BREAK,
  severityAmount,
  TARGET,
  TIME_SPANS,
  xpForNextLevel,
  type Severity,
} from "./rules.ts";
import type { Action, Change, CheckAction, Effect } from "./tools.ts";

export interface Rejection {
  action: string;
  reason: string;
}

/** Memory rows that follow from a plan, written at commit with the turn's origin. */
export type PendingMemory =
  | { kind: "alias"; entity: string; alias: string }
  | { kind: "fact"; fact: NewFact; witnesses: boolean };

export interface Resolution {
  events: GameEvent[];
  mechanics: string[];
  rejections: Rejection[];
  notes: string[];
  memory: PendingMemory[];
  created: string[];
  checks: { description: string; success: boolean }[];
  sceneBreak: string | null;
  timeBefore: number;
  timeAfter: number;
}

export interface EngineOptions {
  seed: number;
  permadeath?: boolean;
}

const NPC_HP: Record<Severity, number> = { minor: 6, moderate: 14, major: 30, massive: 60 };

export function describeAction(a: Action | Change): string {
  const { tool, ...rest } = a as any;
  const short = JSON.stringify(rest);
  return `${tool}(${short.length > 160 ? short.slice(0, 157) + "..." : short})`;
}

/**
 * Resolves a plan against current hard state. Runs inside a savepoint that is always
 * rolled back: it only computes the events. Commit re-applies those events for real,
 * which yields the same state because events carry absolute values.
 */
export function resolvePlan(db: DB, actions: Action[], opts: EngineOptions): Resolution {
  db.exec("SAVEPOINT resolve");
  try {
    return new Resolver(db, opts).run(actions);
  } finally {
    db.exec("ROLLBACK TO resolve");
    db.exec("RELEASE resolve");
  }
}

class Resolver {
  private out: Resolution;
  private rand: () => number;
  private local = new Map<string, string>();
  private statusSeq = 0;

  constructor(
    private db: DB,
    private opts: EngineOptions,
  ) {
    this.rand = rng(opts.seed);
    const t = gameTime(db);
    this.out = {
      events: [],
      mechanics: [],
      rejections: [],
      notes: [],
      memory: [],
      created: [],
      checks: [],
      sceneBreak: null,
      timeBefore: t,
      timeAfter: t,
    };
  }

  run(actions: Action[]): Resolution {
    for (const a of actions) this.dispatch(a);
    if (this.out.sceneBreak) {
      this.emit({
        type: "scene_started",
        scene: currentScene(this.db) + 1,
        reason: this.out.sceneBreak,
        location: getEntity(this.db, PLAYER)?.location ?? null,
      });
    }
    this.out.timeAfter = gameTime(this.db);
    return this.out;
  }

  private emit(e: GameEvent) {
    this.out.events.push(e);
    applyEvent(this.db, e, 0, gameTime(this.db));
  }

  private reject(a: Action | Change, reason: string) {
    this.out.rejections.push({ action: describeAction(a), reason });
  }

  private scene(): string[] {
    const loc = getEntity(this.db, PLAYER)?.location;
    return loc ? [PLAYER, loc, ...entitiesAt(this.db, loc).map((e) => e.id)] : [PLAYER];
  }

  private ref(r: string | undefined): string | null {
    if (!r) return null;
    const l = this.local.get(norm(r)) ?? this.local.get(r);
    if (l) return l;
    return resolveRef(this.db, r, this.scene());
  }

  private entity(a: Action | Change, r: string, what = "entity"): string | null {
    const id = this.ref(r);
    if (!id || id === WORLD || !getEntity(this.db, id)) {
      this.reject(a, `No ${what} '${r}' exists. Create it first, or use one that exists.`);
      return null;
    }
    return id;
  }

  private dispatch(a: Action | Change) {
    switch (a.tool) {
      case "check":
        return this.check(a as CheckAction);
      case "adjust":
        return this.adjust(a);
      case "transfer":
        return this.transfer(a);
      case "move":
        return this.move(a);
      case "create":
        return this.create(a);
      case "add_status":
        return this.addStatus(a);
      case "remove_status":
        return this.removeStatus(a);
      case "define_stat":
        return this.defineStat(a);
      case "set_alive":
        return this.setAlive(a);
      case "advance_time":
        return this.advanceTime(a);
      case "record_fact":
        return this.recordFact(a);
      case "thread":
        return this.thread(a);
      case "end_scene":
        this.out.sceneBreak ??= a.reason || "scene ended";
        return;
    }
  }

  // ── check ────────────────────────────────────────────────────────────────
  private check(a: CheckAction) {
    const actor = this.entity(a, a.actor);
    if (!actor) return;
    const e = getEntity(this.db, actor)!;
    if (!e.alive) return this.reject(a, `${e.name} is dead and can't act.`);
    const attr = a.attribute.toLowerCase();
    const attrStat = getStat(this.db, actor, attr);
    if (!attrStat && actor === PLAYER) {
      this.out.notes.push(`Unknown attribute '${a.attribute}' for the player; rolled with +0.`);
    }
    const attrMod = attrStat?.value ?? 0;
    const traits = traitsOf(this.db, actor);
    const used: { label: string; bonus: number }[] = [];
    for (const t of a.traits) {
      const n = norm(t);
      const m = traits.find((x) => norm(x.label) === n || norm(x.label).includes(n) || n.includes(norm(x.label)));
      if (m && !used.includes(m)) used.push(m);
      else if (!m) this.out.notes.push(`${e.name} has no trait '${t}'; it gave no bonus.`);
    }
    const statusBonus = effectsOf(this.db, actor)
      .filter((x): x is Extract<Effect, { type: "check_modifier" }> => x.type === "check_modifier")
      .filter((x) => x.attribute === "all" || x.attribute.toLowerCase() === attr)
      .reduce((s, x) => s + x.bonus, 0);
    const roll = 1 + Math.floor(this.rand() * 20);
    const bonus = attrMod + used.reduce((s, t) => s + t.bonus, 0) + statusBonus;
    const total = roll + bonus;
    const target = TARGET[a.difficulty];
    const success = total >= target;
    this.emit({
      type: "check_rolled",
      actor,
      description: a.description,
      attribute: attr,
      difficulty: a.difficulty,
      roll,
      bonus,
      total,
      target,
      success,
    });
    const bonusText = bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : `${bonus}`;
    const parts = [`${attr} ${attrMod >= 0 ? "+" : ""}${attrMod}`, ...used.map((t) => `${t.label} ${t.bonus >= 0 ? "+" : ""}${t.bonus}`)];
    if (statusBonus) parts.push(`statuses ${statusBonus >= 0 ? "+" : ""}${statusBonus}`);
    this.out.mechanics.push(
      `${a.description} (${attr}, ${a.difficulty.replace("_", " ")}): ${roll}${bonusText} = ${total} vs ${target} → ${success ? "SUCCESS" : "FAILURE"} [${parts.join(", ")}]`,
    );
    this.out.checks.push({ description: a.description, success });
    for (const c of success ? a.onSuccess : a.onFailure) this.dispatch(c);
  }

  // ── adjust ───────────────────────────────────────────────────────────────
  private adjust(a: Extract<Change, { tool: "adjust" }>) {
    const ent = this.entity(a, a.entity);
    if (!ent) return;
    const e = getEntity(this.db, ent)!;
    const stat = a.stat.toLowerCase().trim();
    const toward = a.toward ? (this.ref(a.toward) ?? a.toward) : "";
    if (stat === "gold") return this.reject(a, "Gold is held, not a stat: use transfer with item 'gold'.");
    if (!e.alive && (stat === "hp" || stat === "mana")) {
      return this.reject(a, `${e.name} is dead. The dead stay dead unless set_alive revives them.`);
    }
    let s = getStat(this.db, ent, stat, toward);
    if (!s) {
      if (stat === "hp") {
        const max = Math.round(NPC_HP.moderate * levelScale(level(this.db, PLAYER)));
        this.emit({ type: "stat_set", entity: ent, stat: "hp", toward: "", value: max, max, category: "core" });
        s = getStat(this.db, ent, stat, toward)!;
      } else if (stat === "mana" || stat === "xp" || stat === "level") {
        return this.reject(a, `${e.name} has no ${stat}.`);
      } else {
        this.emit({ type: "stat_set", entity: ent, stat, toward, value: 0, max: null, category: "custom" });
        s = getStat(this.db, ent, stat, toward)!;
        this.out.notes.push(`Defined new stat '${stat}' on ${e.name} starting at 0.`);
      }
    }
    const lvl = level(this.db, PLAYER); // amounts scale with the player's level
    const effMax = effectiveMax(this.db, ent, stat, toward);
    let amount: number;
    let how: string;
    const given = [a.severity, a.reward, a.amount].filter((x) => x != null).length;
    if (given !== 1) return this.reject(a, "adjust needs exactly one of severity, reward or amount.");
    if (a.amount != null) {
      amount = a.amount;
      how = "exact";
    } else if (a.reward) {
      amount = rewardAmount(this.rand, a.reward, "xp", lvl);
      how = `${a.reward} reward`;
    } else {
      amount = severityAmount(this.rand, a.severity!, stat, lvl, effMax);
      how = a.severity!;
    }
    const delta = a.direction === "up" ? amount : -amount;
    if (stat === "xp") return this.gainXp(a, ent, delta);
    let next = s.value + delta;
    if (stat === "hp" || stat === "mana") next = clamp(next, 0, effMax ?? next);
    else if (s.max != null) next = clamp(next, 0, effMax ?? s.max);
    if (stat === "level") next = Math.max(1, Math.round(next));
    if (next === s.value) {
      this.out.mechanics.push(`${e.name}: ${stat} stays ${s.value}${effMax != null ? `/${effMax}` : ""} (${how}, already at the limit)`);
      return;
    }
    this.emit({ type: "stat_set", entity: ent, stat, toward, value: next, max: s.max, category: s.category, delta: next - s.value, reason: a.reason });
    const label = toward ? `${stat} toward ${nameOf(this.db, toward)}` : stat.toUpperCase() === "HP" ? "HP" : stat;
    this.out.mechanics.push(
      `${e.name}: ${label} ${s.value} → ${next}${effMax != null ? `/${effMax}` : ""} (${a.direction === "up" ? "+" : "−"}${Math.abs(next - s.value)}, ${how}${a.reason ? `: ${a.reason}` : ""})`,
    );
    if (stat === "hp" && next === 0) this.atZeroHp(ent);
  }

  private atZeroHp(ent: string) {
    const e = getEntity(this.db, ent)!;
    if (ent === PLAYER) {
      if (this.opts.permadeath) {
        this.emit({ type: "alive_set", entity: PLAYER, alive: false, cause: "reduced to 0 HP" });
        this.out.notes.push("The player has died (permanent death is on).");
      } else {
        if (!statusesOf(this.db, PLAYER).some((s) => s.label === "downed")) this.addStatusRaw(PLAYER, "downed", [], null);
        this.out.notes.push(
          "The player is DOWNED at 0 HP, not dead. Turn it into a story event: captured, rescued, or waking up hurt.",
        );
      }
    } else {
      if (!statusesOf(this.db, ent).some((s) => s.label === "defeated")) this.addStatusRaw(ent, "defeated", [], null);
      this.out.notes.push(`${e.name} is at 0 HP and defeated. Use set_alive only if they actually die.`);
    }
  }

  private gainXp(a: Change, ent: string, delta: number) {
    const e = getEntity(this.db, ent)!;
    const xp = getStat(this.db, ent, "xp");
    if (!xp) return this.reject(a, `${e.name} doesn't gain XP.`);
    let value = Math.max(0, xp.value + delta);
    let lvl = level(this.db, ent);
    this.out.mechanics.push(`${e.name}: XP ${xp.value} → ${value} (${delta >= 0 ? "+" : ""}${delta})`);
    while (value >= xpForNextLevel(lvl)) {
      value -= xpForNextLevel(lvl);
      lvl++;
      this.emit({ type: "stat_set", entity: ent, stat: "level", toward: "", value: lvl, max: null, category: "core" });
      const body = getStat(this.db, ent, "body")?.value ?? 0;
      const mind = getStat(this.db, ent, "mind")?.value ?? 0;
      for (const [stat, max] of [
        ["hp", baseMaxHp(body, lvl)],
        ["mana", baseMaxMana(mind, lvl)],
      ] as const) {
        const s = getStat(this.db, ent, stat);
        if (!s || s.max == null) continue;
        const gain = Math.max(0, max - s.max);
        this.emit({ type: "stat_set", entity: ent, stat, toward: "", value: s.value + gain, max: s.max + gain, category: "core" });
      }
      this.out.mechanics.push(`${e.name} reached level ${lvl}!`);
    }
    this.emit({ type: "stat_set", entity: ent, stat: "xp", toward: "", value, max: null, category: "core", delta });
  }

  // ── transfer ─────────────────────────────────────────────────────────────
  private transfer(a: Extract<Change, { tool: "transfer" }>) {
    const from = a.from === WORLD ? WORLD : this.entity(a, a.from, "holder");
    if (!from) return;
    const to = a.to === WORLD ? WORLD : this.entity(a, a.to, "holder");
    if (!to) return;
    if (from === to) return this.reject(a, "from and to are the same holder.");
    let item: string | null = norm(a.item) === "gold" || /^gold( coins?| pieces?)?$/.test(norm(a.item)) ? GOLD : this.ref(a.item);
    if (!item) {
      if (from !== WORLD) {
        return this.reject(a, `${nameOf(this.db, from)} has no '${a.item}'. Nothing by that name exists yet.`);
      }
      item = this.createRaw(a, "item", a.item, "", null, [], false);
    }
    if (item !== GOLD && getEntity(this.db, item)?.kind && isPlaceKind(getEntity(this.db, item)!.kind)) {
      return this.reject(a, `${nameOf(this.db, item)} is a place, not something that can be held.`);
    }
    let qty: number;
    if (a.quantity != null) qty = a.quantity;
    else if (a.reward) qty = item === GOLD ? rewardAmount(this.rand, a.reward, "gold", level(this.db, PLAYER)) : 1;
    else qty = 1;
    if (from !== WORLD) {
      const have = holding(this.db, from, item);
      if (have < qty) {
        return this.reject(
          a,
          `${nameOf(this.db, from)} has ${have} ${item === GOLD ? "gold" : `× ${nameOf(this.db, item)}`}, not ${qty}. You can't spend, give or use what you don't have.`,
        );
      }
      this.emit({ type: "holding_set", holder: from, item, qty: have - qty, delta: -qty });
    }
    if (to !== WORLD) {
      const have = holding(this.db, to, item);
      this.emit({ type: "holding_set", holder: to, item, qty: have + qty, delta: qty });
    }
    const what = item === GOLD ? `${qty} gold` : `${qty > 1 ? `${qty} × ` : ""}${nameOf(this.db, item)}`;
    const after =
      from === PLAYER || to === PLAYER ? ` (player now has ${holding(this.db, PLAYER, item)}${item === GOLD ? " gold" : ""})` : "";
    const verb = from === WORLD ? `${nameOf(this.db, to)} gains ${what}` : to === WORLD ? `${nameOf(this.db, from)} loses ${what}` : `${what}: ${nameOf(this.db, from)} → ${nameOf(this.db, to)}`;
    this.out.mechanics.push(`${verb}${after}${a.reason ? ` — ${a.reason}` : ""}`);
  }

  // ── move ─────────────────────────────────────────────────────────────────
  private move(a: Extract<Change, { tool: "move" }>) {
    const ent = this.entity(a, a.entity);
    if (!ent) return;
    const to = this.entity(a, a.to, "location");
    if (!to) return;
    if (ent === to) return this.reject(a, "An entity can't be inside itself.");
    // Rule 3: one place at a time — reject cycles (a place inside something inside it).
    for (let cur: string | null = to, i = 0; cur && i < 20; i++) {
      if (cur === ent) return this.reject(a, `${nameOf(this.db, to)} is inside ${nameOf(this.db, ent)}.`);
      cur = getEntity(this.db, cur)?.location ?? null;
    }
    const e = getEntity(this.db, ent)!;
    if (e.location === to) return;
    this.emit({ type: "moved", entity: ent, from: e.location, to });
    this.out.mechanics.push(`${e.name} moves to ${nameOf(this.db, to)}`);
    if (ent === PLAYER) this.out.sceneBreak ??= `travelled to ${nameOf(this.db, to)}`;
  }

  // ── create ───────────────────────────────────────────────────────────────
  private create(a: Extract<Change, { tool: "create" }>) {
    let location: string | null = null;
    if (a.location) {
      location = this.ref(a.location);
      if (!location) this.out.notes.push(`Location '${a.location}' for new ${a.name} is unknown; created without a location.`);
    } else if (!isPlaceKind(a.kind)) {
      location = getEntity(this.db, PLAYER)?.location ?? null;
    }
    const id = this.createRaw(a, a.kind, a.name, a.description, location, a.aliases, a.stub, a.id);
    if (a.hp) {
      const max = Math.round(NPC_HP[a.hp] * levelScale(level(this.db, PLAYER)));
      this.emit({ type: "stat_set", entity: id, stat: "hp", toward: "", value: max, max, category: "core" });
    }
  }

  private createRaw(
    _a: Action | Change,
    kind: string,
    name: string,
    description: string,
    location: string | null,
    aliases: string[],
    stub: boolean,
    wanted?: string,
  ): string {
    const id = newEntityId(this.db, kind, name, wanted ? slug(wanted) : undefined);
    this.emit({ type: "entity_created", id, kind: kind.toLowerCase(), name, description, location, alive: true, stub });
    for (const n of [name, ...aliases]) {
      this.out.memory.push({ kind: "alias", entity: id, alias: n });
      this.local.set(norm(n), id);
    }
    if (wanted) this.local.set(wanted, id);
    this.local.set(id, id);
    this.out.created.push(id);
    this.out.mechanics.push(`New ${kind}: ${name} [${id}]${location ? ` at ${nameOf(this.db, location)}` : ""}`);
    return id;
  }

  // ── statuses ─────────────────────────────────────────────────────────────
  private addStatus(a: Extract<Change, { tool: "add_status" }>) {
    const ent = this.entity(a, a.entity);
    if (!ent) return;
    const minutes = a.durationMinutes ?? (a.span ? TIME_SPANS[a.span] : null);
    const expires = minutes != null ? gameTime(this.db) + minutes : null;
    this.addStatusRaw(ent, a.label, a.effects, expires);
  }

  private addStatusRaw(ent: string, label: string, effects: Effect[], expiresAt: number | null) {
    const id = `st_${slug(ent)}_${slug(label).slice(0, 24)}_${gameTime(this.db)}_${++this.statusSeq}`;
    this.emit({ type: "status_added", id, entity: ent, label, effects, expiresAt });
    this.out.mechanics.push(
      `${nameOf(this.db, ent)} gains status: ${label}${expiresAt != null ? ` (until ${formatTime(expiresAt)})` : ""}`,
    );
    for (const ef of effects) if (ef.type === "max_modifier") this.clampToMax(ent, ef.stat);
  }

  private clampToMax(ent: string, stat: string) {
    const s = getStat(this.db, ent, stat);
    const m = effectiveMax(this.db, ent, stat);
    if (s && m != null && s.value > m) {
      this.emit({ type: "stat_set", entity: ent, stat, toward: "", value: m, max: s.max, category: s.category, delta: m - s.value });
    }
  }

  private removeStatus(a: Extract<Change, { tool: "remove_status" }>) {
    const ent = this.entity(a, a.entity);
    if (!ent) return;
    const n = norm(a.label);
    const sts = statusesOf(this.db, ent);
    const m = sts.find((s) => norm(s.label) === n) ?? sts.find((s) => norm(s.label).startsWith(n) || n.startsWith(norm(s.label)));
    if (!m) {
      return this.reject(
        a,
        `${nameOf(this.db, ent)} has no status '${a.label}'. Current statuses: ${sts.map((s) => s.label).join("; ") || "none"}.`,
      );
    }
    this.emit({ type: "status_removed", id: m.id, reason: "removed" });
    this.out.mechanics.push(`${nameOf(this.db, ent)} loses status: ${m.label}`);
  }

  // ── stats, life ──────────────────────────────────────────────────────────
  private defineStat(a: Extract<Change, { tool: "define_stat" }>) {
    const ent = this.entity(a, a.entity);
    if (!ent) return;
    const name = a.name.toLowerCase().trim();
    const toward = a.toward ? (this.ref(a.toward) ?? a.toward) : "";
    if (name === "gold") return this.reject(a, "Gold is held, not a stat.");
    const ex = getStat(this.db, ent, name, toward);
    if (ex) return this.reject(a, `${nameOf(this.db, ent)} already has ${name} = ${ex.value}. Use adjust to change it.`);
    if (["mana", "xp", "level"].includes(name) && ent === PLAYER) return this.reject(a, `The player's ${name} already exists.`);
    const max = a.max ?? null;
    const value = max != null ? clamp(a.value, 0, max) : a.value;
    const category = name === "hp" || name === "mana" ? "core" : "custom";
    this.emit({ type: "stat_set", entity: ent, stat: name, toward, value, max, category });
    this.out.mechanics.push(
      `${nameOf(this.db, ent)}: new stat ${name}${toward ? ` toward ${nameOf(this.db, toward)}` : ""} ${value}${max != null ? `/${max}` : ""}`,
    );
  }

  private setAlive(a: Extract<Change, { tool: "set_alive" }>) {
    const ent = this.entity(a, a.entity);
    if (!ent) return;
    const e = getEntity(this.db, ent)!;
    if (!!e.alive === a.alive) return this.reject(a, `${e.name} is already ${a.alive ? "alive" : "dead"}.`);
    if (ent === PLAYER && !a.alive && !this.opts.permadeath) {
      this.reject(a, "Story mode: the player can't die. They are downed instead; make it part of the story.");
      const hp = getStat(this.db, PLAYER, "hp");
      if (hp && hp.value > 0)
        this.emit({ type: "stat_set", entity: PLAYER, stat: "hp", toward: "", value: 0, max: hp.max, category: "core", delta: -hp.value });
      this.atZeroHp(PLAYER);
      return;
    }
    this.emit({ type: "alive_set", entity: ent, alive: a.alive, cause: a.cause });
    if (a.alive) {
      const hp = getStat(this.db, ent, "hp");
      if (hp && hp.value <= 0)
        this.emit({ type: "stat_set", entity: ent, stat: "hp", toward: "", value: 1, max: hp.max, category: "core", delta: 1 });
    }
    this.out.mechanics.push(`${e.name} ${a.alive ? "is revived" : "dies"} (${a.cause})`);
  }

  // ── time and effects ─────────────────────────────────────────────────────
  private advanceTime(a: Extract<Change, { tool: "advance_time" }>) {
    const minutes = a.minutes ?? (a.span ? TIME_SPANS[a.span] : 0);
    if (!minutes || minutes <= 0) return this.reject(a, "In-game time only moves forward: give a positive duration.");
    const from = gameTime(this.db);
    const to = from + minutes;
    this.tickEffects(from, to);
    this.emit({ type: "time_set", from, to });
    this.out.mechanics.push(`Time passes: ${formatTime(from)} → ${formatTime(to)}`);
    if (minutes >= SCENE_TIME_BREAK) this.out.sceneBreak ??= "significant time passed";
  }

  private tickEffects(_from: number, to: number) {
    const rows = this.db.query("SELECT * FROM p_statuses ORDER BY id").all() as {
      id: string;
      entity: string;
      label: string;
      effects: string;
      expires_at: number | null;
      last_tick: number;
    }[];
    for (const st of rows) {
      const until = st.expires_at != null ? Math.min(st.expires_at, to) : to;
      for (const ef of json<Effect[]>(st.effects, [])) {
        if (ef.type !== "periodic") continue;
        const ticks = Math.floor((until - st.last_tick) / ef.everyMinutes);
        if (ticks <= 0) continue;
        const toward = ef.toward ?? "";
        const s = getStat(this.db, st.entity, ef.stat, toward);
        if (!s) continue;
        const e = getEntity(this.db, st.entity);
        if (!e?.alive) continue;
        const m = effectiveMax(this.db, st.entity, ef.stat, toward);
        let next = s.value + ef.amount * ticks;
        if (s.category === "core" || s.max != null) next = clamp(next, 0, m ?? next);
        if (next !== s.value) {
          this.emit({ type: "stat_set", entity: st.entity, stat: ef.stat, toward, value: next, max: s.max, category: s.category, delta: next - s.value, reason: st.label });
          this.out.mechanics.push(`${e.name}: ${ef.stat} ${s.value} → ${next} (${st.label}, ×${ticks})`);
          if (ef.stat === "hp" && next === 0) this.atZeroHp(st.entity);
        }
      }
      const periods = json<Effect[]>(st.effects, []).filter((e): e is Extract<Effect, { type: "periodic" }> => e.type === "periodic");
      if (periods.length) {
        const every = Math.min(...periods.map((p) => p.everyMinutes));
        const at = st.last_tick + Math.floor((until - st.last_tick) / every) * every;
        if (at > st.last_tick) this.emit({ type: "status_ticked", id: st.id, at });
      }
      if (st.expires_at != null && st.expires_at <= to) {
        this.emit({ type: "status_removed", id: st.id, reason: "expired" });
        this.out.mechanics.push(`${nameOf(this.db, st.entity)}: status '${st.label}' wears off`);
        for (const ef of json<Effect[]>(st.effects, [])) if (ef.type === "max_modifier") this.clampToMax(st.entity, ef.stat);
      }
    }
  }

  // ── facts and threads ────────────────────────────────────────────────────
  private recordFact(a: Extract<Change, { tool: "record_fact" }>) {
    const subject = this.entity(a, a.subject, "subject");
    if (!subject) return;
    const object = a.object ? (this.ref(a.object) ?? a.object) : null;
    const knownBy = a.knownBy.map((k) => this.ref(k) ?? k).filter(Boolean);
    const witnesses = knownBy.length === 0 && !a.secret;
    this.out.memory.push({
      kind: "fact",
      witnesses,
      fact: {
        subject,
        predicate: a.predicate,
        object,
        statement: a.statement,
        authority: "canon",
        importance: a.importance,
        secret: a.secret || (knownBy.length > 0 && !knownBy.includes(PLAYER)),
        knownBy: knownBy.length ? knownBy : a.secret ? [subject] : [],
      },
    });
    if (a.trait) this.emit({ type: "trait_added", entity: subject, label: a.trait.label, bonus: a.trait.bonus });
    const e = getEntity(this.db, subject)!;
    if (e.stub) this.emit({ type: "stub_filled", entity: subject });
  }

  private thread(a: Extract<Change, { tool: "thread" }>) {
    let id = a.id;
    let existing = id ? (this.db.query("SELECT * FROM p_threads WHERE id = ?").get(id) as any) : null;
    if (id && !existing) {
      // Fall back to matching the title, so a model that guesses an id still updates the thread.
      existing = this.db.query("SELECT * FROM p_threads WHERE lower(title) = lower(?)").get(a.title) as any;
      id = existing?.id;
    }
    if (!id) {
      id = `th_${slug(a.title).slice(0, 30)}`;
      for (let i = 2; this.db.query("SELECT 1 FROM p_threads WHERE id = ?").get(id); i++) id = `th_${slug(a.title).slice(0, 30)}_${i}`;
    }
    const entities = a.entities.map((x) => this.ref(x)).filter((x): x is string => !!x);
    this.emit({
      type: "thread_set",
      id,
      kind: a.kind,
      title: a.title,
      status: a.status,
      summary: a.summary || existing?.summary || "",
      entities: entities.length ? entities : json<string[]>(existing?.entities, []),
      hidden: a.hidden,
    });
    this.out.mechanics.push(`Thread ${existing ? "updated" : "opened"}: ${a.title} [${id}] → ${a.status}`);
  }
}

export function seedFor(campaignSeed: number, head: number, attempt: number): number {
  return hashString(`${campaignSeed}:${head}:${attempt}`);
}

/** Witness default: everyone present with the player. */
export function presentEntities(db: DB): string[] {
  const loc = getEntity(db, PLAYER)?.location;
  if (!loc) return [PLAYER];
  return [PLAYER, ...entitiesAt(db, loc).filter((e) => e.alive && e.id !== PLAYER && isBeing(e.kind)).map((e) => e.id)];
}

export function writePendingMemory(db: DB, items: PendingMemory[], o: Origin, insertFactFn: (f: NewFact, o: Origin) => number) {
  for (const m of items) {
    if (m.kind === "alias") addAlias(db, m.entity, m.alias, o);
    else {
      const knownBy = m.witnesses ? presentEntities(db) : m.fact.knownBy;
      insertFactFn({ ...m.fact, knownBy }, o);
    }
  }
}
