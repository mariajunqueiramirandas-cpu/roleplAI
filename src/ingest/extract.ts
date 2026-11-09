import { z } from "zod";
import { EXTRACTOR_SYSTEM } from "../context/prompts.ts";
import type { Ctx } from "../ctx.ts";
import type { TurnRow } from "../memory/episodes.ts";
import { getEntity } from "../state/read.ts";
import { json } from "../util.ts";

export const ExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        mention: z.string(),
        id: z.string().nullish().describe("Known entity id, or null if not in the list"),
        kind: z.string().default("thing"),
        name: z.string().nullish(),
        description: z.string().default(""),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        subject: z.string().describe("Entity id or the mention as written"),
        predicate: z.string().default(""),
        object: z.string().nullish(),
        statement: z.string(),
        importance: z.number().min(1).max(10).default(5),
        secret: z.boolean().default(false),
        knownBy: z.array(z.string()).nullish().describe("Omit for everyone present"),
      }),
    )
    .default([]),
  threads: z
    .array(
      z.object({
        id: z.string().nullish(),
        status: z.enum(["open", "progressing", "resolved", "failed", "abandoned"]),
        kind: z.enum(["quest", "promise", "debt", "mystery", "foreshadowing", "goal"]).default("quest"),
        title: z.string(),
        summary: z.string().default(""),
        entities: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  importance: z.number().min(1).max(10).default(3),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface TurnOutcome {
  mechanics: string[];
  notes: string[];
  rejections: { action: string; reason: string }[];
  present: string[];
  sceneEntities: string[];
  linked: string[];
  sceneEnded: string | null;
  checks: { description: string; success: boolean }[];
  contextKeys: string[];
  created: string[];
}

export async function extractTurn(ctx: Ctx, t: TurnRow, known: string[]): Promise<Extraction> {
  const outcome = json<TurnOutcome>(t.outcome, {} as TurnOutcome);
  const list = known
    .map((id) => getEntity(ctx.db, id))
    .filter(Boolean)
    .map((e) => `- ${e!.id}: ${e!.name} (${e!.kind})`)
    .join("\n");
  const user = [
    `KNOWN ENTITIES IN THE SCENE (use these ids)\n${list || "- player: the player character"}`,
    `PRESENT: ${(outcome.present ?? []).join(", ") || "player"}`,
    `PLAYER INPUT\n${t.input}`,
    `PLAN AND RESOLVED OUTCOME\n${(outcome.mechanics ?? []).map((m) => `- ${m}`).join("\n") || "- none"}`,
    `PROSE\n${t.prose}`,
  ].join("\n\n");
  return ctx.llm.structured(
    "extractor",
    "extract",
    [
      { role: "system", content: EXTRACTOR_SYSTEM },
      { role: "user", content: user },
    ],
    ExtractionSchema,
    {
      meta: {
        input: t.input,
        prose: t.prose,
        known,
        names: Object.fromEntries(known.map((id) => [id, getEntity(ctx.db, id)?.name ?? id])),
        present: outcome.present ?? [],
      },
    },
  );
}
