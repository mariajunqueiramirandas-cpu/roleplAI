/** Small shared helpers with no dependencies on the rest of the system. */

export const PLAYER = "player";
export const WORLD = "world";
export const GOLD = "gold";

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "x"
  );
}

/** Normalise a name or mention for alias matching: "The Old Smith!" → "old smith". */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

const STOP = new Set(
  "a an the and or but of to in on at for with from by is are was were be been it its this that these those he she they them his her their i you we me my your our as do does did not no so if then than there here what who whom which when where why how about into over under up down out off again all any each some such only own same too very can will just should now".split(
    " ",
  ),
);

/** Content words of a text, for keyword queries and simple overlap scores. */
export function words(text: string): string[] {
  return norm(text)
    .split(" ")
    .map((w) => w.replace(/'s$/, "").replace(/'/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** A safe FTS5 MATCH expression: quoted content words joined with OR. */
export function ftsQuery(text: string): string | null {
  // FTS5's tokenizer splits on apostrophes, so "Xal'thuun" is searched as the phrase "xal thuun".
  const terms = norm(text)
    .split(" ")
    .map((w) => w.replace(/'s$/, ""))
    .filter((w) => w.length > 1 && !STOP.has(w.replace(/'/g, "")))
    .map((w) => w.split("'").filter(Boolean).join(" "));
  const uniq = [...new Set(terms)].slice(0, 24);
  if (!uniq.length) return null;
  return uniq.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

export function formatTime(minutes: number): string {
  const day = Math.floor(minutes / 1440) + 1;
  const m = minutes % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `Day ${day} ${hh}:${mm}`;
}

export function dayOf(minutes: number): number {
  return Math.floor(minutes / 1440) + 1;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function now(): string {
  return new Date().toISOString();
}

export function json<T = unknown>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Deterministic PRNG (mulberry32). Dice are seeded per turn so runs are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  push<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const p = this.tail.then(fn, fn).finally(() => this.pending--);
    this.tail = p.catch(() => undefined);
    return p as Promise<T>;
  }
  get size() {
    return this.pending;
  }
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
