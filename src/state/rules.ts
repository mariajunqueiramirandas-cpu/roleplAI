/**
 * Game balance lives here and only here. The model picks labels; these tables
 * turn them into numbers. Tunable without touching anything else.
 */

export const DIFFICULTIES = ["trivial", "easy", "medium", "hard", "very_hard", "extreme"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const TARGET: Record<Difficulty, number> = {
  trivial: 5,
  easy: 10,
  medium: 13,
  hard: 16,
  very_hard: 19,
  extreme: 23,
};

export const SEVERITIES = ["minor", "moderate", "major", "massive"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Dice for HP and mana changes at level 1: [count, sides]. */
export const SEVERITY_DICE: Record<Severity, [number, number]> = {
  minor: [1, 4],
  moderate: [2, 6],
  major: [4, 6],
  massive: [8, 6],
};
/** For custom stats: fraction of the stat's max (or of 10 if it has none). */
export const SEVERITY_FRACTION: Record<Severity, number> = {
  minor: 0.1,
  moderate: 0.25,
  major: 0.5,
  massive: 1,
};

export const REWARDS = ["small", "fair", "large", "huge"] as const;
export type Reward = (typeof REWARDS)[number];
export const REWARD_GOLD: Record<Reward, number> = { small: 5, fair: 15, large: 40, huge: 100 };
export const REWARD_XP: Record<Reward, number> = { small: 10, fair: 25, large: 60, huge: 150 };

export const DEFAULT_ATTRIBUTES = ["body", "agility", "mind", "presence"] as const;
export const ATTRIBUTE_LABELS = ["poor", "average", "good", "strong", "exceptional"] as const;
export type AttributeLabel = (typeof ATTRIBUTE_LABELS)[number];
/** An attribute's value is its check modifier. */
export const ATTRIBUTE_MOD: Record<AttributeLabel, number> = { poor: -1, average: 0, good: 1, strong: 2, exceptional: 3 };

export const WEALTH = ["destitute", "poor", "modest", "comfortable", "rich"] as const;
export type Wealth = (typeof WEALTH)[number];
export const WEALTH_GOLD: Record<Wealth, number> = { destitute: 0, poor: 5, modest: 25, comfortable: 80, rich: 300 };

/** Spans the planner may name instead of minutes. */
export const TIME_SPANS = {
  moment: 1,
  minutes: 10,
  half_hour: 30,
  hour: 60,
  hours: 240,
  evening: 360,
  night: 480,
  day: 1440,
  days: 4320,
  week: 10080,
} as const;
export type TimeSpan = keyof typeof TIME_SPANS;

/** A scene ends on its own when this much in-game time passes in one turn. */
export const SCENE_TIME_BREAK = 180;

export const CORE_STATS = ["hp", "mana", "xp", "level"] as const;

/** Level scaling: 1 at level 1, +25% per level after. */
export function levelScale(level: number): number {
  return 1 + Math.max(0, level - 1) * 0.25;
}

export function xpForNextLevel(level: number): number {
  return 100 * level;
}

export function baseMaxHp(body: number, level: number): number {
  return 20 + 5 * body + (level - 1) * (6 + body);
}

export function baseMaxMana(mind: number, level: number): number {
  return Math.max(0, 10 + 5 * mind + (level - 1) * (3 + mind));
}

export function rollDice(rand: () => number, count: number, sides: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rand() * sides);
  return total;
}

export function severityAmount(rand: () => number, sev: Severity, stat: string, level: number, max: number | null): number {
  if (stat === "hp" || stat === "mana") {
    const [n, s] = SEVERITY_DICE[sev];
    return Math.max(1, Math.round(rollDice(rand, n, s) * levelScale(level)));
  }
  return Math.max(1, Math.round((max ?? 10) * SEVERITY_FRACTION[sev]));
}

export function rewardAmount(rand: () => number, r: Reward, kind: "gold" | "xp", level: number): number {
  const base = (kind === "gold" ? REWARD_GOLD : REWARD_XP)[r] * level;
  const jitter = 0.8 + rand() * 0.4; // ±20%
  return Math.max(1, Math.round(base * jitter));
}
