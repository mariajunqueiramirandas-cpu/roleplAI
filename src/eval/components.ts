import type { Config, DeepPartial } from "../config.ts";
import { Game } from "../game.ts";
import { labelPairs, type Label } from "../ingest/contradiction.ts";
import { linkMention } from "../ingest/link.ts";
import { insertFact } from "../memory/facts.ts";
import { storeEmbeddings } from "../memory/vectors.ts";
import { retrieve } from "../retrieval/retrieve.ts";
import { currentOrigin } from "../turn/pipeline.ts";
import { PLAYER } from "../util.ts";
import { sampleWorld } from "../world/sample.ts";

/**
 * Component tests: fast and cheap, run on every change. Each has fixed inputs and
 * known correct answers, so a model or retrieval change can be scored in isolation.
 */

export const RETRIEVAL_FIXTURE = {
  facts: [
    { subject: "npc_mira", statement: "Mira promised to forge a sword for 3 wolf pelts." },
    { subject: "npc_mira", statement: "Mira's forge fire has burned for forty years without going out." },
    { subject: "npc_vyr", statement: "Vyr waters the ale on market days." },
    { subject: "npc_tomas", statement: "Tomas owes 200 gold to a card dealer in the Grey Marches." },
    { subject: "npc_captain_hale", statement: "Captain Hale lost his left eye fighting the Red Hands." },
    { subject: "place_ruined_tower", statement: "The Ruined Tower has three floors and a collapsed stair." },
    { subject: "place_ruined_tower", statement: "Xal'thuun, a bound spirit, sleeps beneath the Ruined Tower." },
    { subject: "place_sleeping_fox", statement: "The Sleeping Fox has a secret cellar behind the wine racks." },
    { subject: "npc_mira", statement: "Mira hates the smell of lilies since her mother's funeral." },
    { subject: "player", statement: "Ash lost a bet to Tomas on the first night." },
  ],
  queries: [
    { query: "What did the smith ask for in exchange for the sword?", expect: "wolf pelts", scene: ["npc_mira"] },
    { query: "Who is Xal'thuun?", expect: "Xal'thuun", scene: [] },
    { query: "How many floors does the tower have?", expect: "three floors", scene: [] },
    { query: "Does Tomas have money problems?", expect: "owes 200 gold", scene: ["npc_tomas"] },
    { query: "What happened to Captain Hale's eye?", expect: "left eye", scene: [] },
    { query: "Is there a hidden room in the inn?", expect: "secret cellar", scene: [] },
  ],
};

export const LINKING_FIXTURE: { mention: string; expect: string | null; scene: string[] }[] = [
  { mention: "Mira", expect: "npc_mira", scene: [] },
  { mention: "the old smith", expect: "npc_mira", scene: [] },
  { mention: "the blacksmith", expect: "npc_mira", scene: [] },
  { mention: "her", expect: "npc_mira", scene: ["player", "npc_mira"] },
  { mention: "the innkeeper", expect: "npc_vyr", scene: [] },
  { mention: "Captain Hale", expect: "npc_captain_hale", scene: [] },
  { mention: "Hale", expect: "npc_captain_hale", scene: [] },
  { mention: "Tomas", expect: "npc_tomas", scene: [] },
  { mention: "the Rusty Anvil", expect: "place_rusty_anvil", scene: [] },
  { mention: "Oakvale", expect: "place_oakvale", scene: [] },
  { mention: "Zebediah the tinker", expect: null, scene: [] },
];

export const CONTRADICTION_FIXTURE: { subject: string; existing: string; next: string; expect: Label }[] = [
  { subject: "place_ruined_tower", existing: "The Ruined Tower has three floors.", next: "The Ruined Tower has five floors.", expect: "contradiction" },
  { subject: "npc_mira", existing: "Mira lives in Oakvale.", next: "Mira lives in Oakvale.", expect: "duplicate" },
  { subject: "npc_mira", existing: "Mira lives in Oakvale.", next: "Mira has a scar on her left hand.", expect: "new_detail" },
  { subject: "npc_mira", existing: "Mira lives in Oakvale.", next: "Mira has now moved to the Grey Marches after the fire.", expect: "update" },
  { subject: "npc_tomas", existing: "Tomas owes 200 gold to a card dealer.", next: "Tomas owes 200 gold to a card dealer.", expect: "duplicate" },
  { subject: "npc_vyr", existing: "Vyr has two daughters.", next: "Vyr has four daughters.", expect: "contradiction" },
];

export async function runComponentEvals(config: DeepPartial<Config> = {}) {
  const { game } = await Game.create(":memory:", { premise: "fixture", character: "a sellsword named Ash", fixed: sampleWorld("Ash") }, { config, rngSeed: 1 });
  const ctx = game.ctx;
  const o = currentOrigin(ctx);

  // Retrieval recall@k
  const ids = RETRIEVAL_FIXTURE.facts.map((f) => insertFact(ctx.db, { ...f, authority: "narrative", importance: 5, knownBy: [PLAYER] }, o));
  await storeEmbeddings(ctx.db, ctx.llm, ids.map((id, i) => ({ type: "fact", item: id, text: RETRIEVAL_FIXTURE.facts[i].statement })), o);
  const ranks: (number | null)[] = [];
  for (const q of RETRIEVAL_FIXTURE.queries) {
    const res = await retrieve(ctx, { queries: [q.query], sceneEntities: q.scene, linked: [], refersToPast: false, excludeTurns: [] });
    const i = res.findIndex((m) => m.text.toLowerCase().includes(q.expect.toLowerCase()));
    ranks.push(i < 0 ? null : i + 1);
  }
  const recall = (k: number) => ranks.filter((r) => r != null && r <= k).length / ranks.length;

  // Linking
  const linkErrors: string[] = [];
  for (const l of LINKING_FIXTURE) {
    const r = await linkMention(ctx, l.mention, l.scene, "");
    if (r.id !== l.expect) linkErrors.push(`${l.mention}: got ${r.id}, expected ${l.expect}`);
  }

  // Contradiction labels
  const confusion: Record<string, Record<string, number>> = {};
  let right = 0;
  for (const c of CONTRADICTION_FIXTURE) {
    const id = insertFact(ctx.db, { subject: c.subject, statement: c.existing, authority: "narrative", knownBy: [PLAYER] }, o);
    const labels = await labelPairs(ctx, { subject: c.subject, statement: c.next, authority: "narrative", knownBy: [PLAYER] }, [
      { id, subject: c.subject, predicate: "", object: null, statement: c.existing, valid_from_time: 0, valid_from_turn: 0, valid_to_time: null, valid_to_turn: null, superseded_by: null, authority: "narrative", importance: 5, secret: 0, source: o.turn, segment: o.segment, turn: o.turn },
    ]);
    const got = labels.get(id) ?? "new_detail";
    (confusion[c.expect] ??= {})[got] = (confusion[c.expect]?.[got] ?? 0) + 1;
    if (got === c.expect) right++;
  }
  game.close();
  return {
    retrieval: { n: ranks.length, ranks, "recall@1": recall(1), "recall@5": recall(5), "recall@10": recall(10) },
    linking: { n: LINKING_FIXTURE.length, accuracy: 1 - linkErrors.length / LINKING_FIXTURE.length, errors: linkErrors },
    contradiction: { n: CONTRADICTION_FIXTURE.length, accuracy: right / CONTRADICTION_FIXTURE.length, confusion },
  };
}
