import { z } from "zod";
import { DIFFICULTIES, REWARDS, SEVERITIES, TIME_SPANS } from "./rules.ts";

/**
 * The planner's tools. Deliberately few and generic: every hard change and every
 * deliberate world fact goes through one of these.
 */

const id = z.string().min(1).describe("Entity id (e.g. npc_mira) or an exact name; 'player' is the player character");

export const EffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("periodic"),
    stat: z.string().describe("Stat changed each period, e.g. hp or sanity"),
    toward: z.string().optional(),
    amount: z.number().describe("Change per period, negative to drain"),
    everyMinutes: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("check_modifier"),
    attribute: z.string().describe("Attribute affected, or 'all'"),
    bonus: z.number().int(),
  }),
  z.object({
    type: z.literal("max_modifier"),
    stat: z.string(),
    amount: z.number().int().describe("Change to the stat's maximum while the status lasts"),
  }),
]);
export type Effect = z.infer<typeof EffectSchema>;

export const AdjustSchema = z
  .object({
    entity: id,
    stat: z.string().describe("hp, mana, xp, or any custom stat"),
    toward: z.string().optional().describe("For relationship stats: the entity the feeling is toward"),
    direction: z.enum(["up", "down"]),
    severity: z.enum(SEVERITIES).optional().describe("Size of the change; the engine rolls the number"),
    reward: z.enum(REWARDS).optional().describe("For xp rewards; the engine scales it by level"),
    amount: z.number().positive().optional().describe("Only when the story names an exact amount"),
    reason: z.string().default(""),
  })
  .describe("Change any stat by a severity label, a reward size, or a named amount");

export const TransferSchema = z
  .object({
    from: id.describe("Holder giving: an entity id, or 'world' to create"),
    to: id.describe("Holder receiving: an entity id, or 'world' to destroy"),
    item: z.string().describe("'gold' or an item id/name"),
    quantity: z.number().int().positive().optional().describe("Exact count when the story names it (a price)"),
    reward: z.enum(REWARDS).optional().describe("For gold found or paid as a reward; the engine picks the number"),
    reason: z.string().default(""),
  })
  .describe("Move gold or items between two holders");

export const MoveSchema = z.object({ entity: id, to: id.describe("Location id or name") }).describe("Put an entity in a location");

export const CreateSchema = z
  .object({
    kind: z.string().describe("Free text: npc, place, item, faction, creature, disease, religion..."),
    name: z.string(),
    id: z.string().optional().describe("Optional id to refer to it later in this plan"),
    description: z.string().default(""),
    location: z.string().optional().describe("Where it is (for places: the region it is in)"),
    aliases: z.array(z.string()).default([]),
    stub: z.boolean().default(false).describe("True to name it now and fill in details later"),
    hp: z.enum(SEVERITIES).optional().describe("For creatures and NPCs that can fight: how tough they are"),
  })
  .describe("Create a new entity of any kind");

export const AddStatusSchema = z
  .object({
    entity: id,
    label: z.string().describe("Free text, e.g. 'cursed: speaks only in rhymes'"),
    durationMinutes: z.number().int().positive().optional(),
    span: z.enum(Object.keys(TIME_SPANS) as [keyof typeof TIME_SPANS, ...(keyof typeof TIME_SPANS)[]]).optional(),
    effects: z.array(EffectSchema).default([]),
  })
  .describe("Add a status with optional duration and effects");

export const RemoveStatusSchema = z.object({ entity: id, label: z.string() }).describe("Remove a status by its label");

export const DefineStatSchema = z
  .object({
    entity: id,
    name: z.string().describe("e.g. sanity, patience, trust"),
    toward: z.string().optional().describe("For relationships: who the stat is toward"),
    value: z.number(),
    max: z.number().optional(),
  })
  .describe("Create a custom stat on any entity");

export const SetAliveSchema = z
  .object({ entity: id, alive: z.boolean(), cause: z.string().min(1) })
  .describe("Death or revival, with a cause");

export const AdvanceTimeSchema = z
  .object({
    minutes: z.number().int().positive().optional(),
    span: z.enum(Object.keys(TIME_SPANS) as [keyof typeof TIME_SPANS, ...(keyof typeof TIME_SPANS)[]]).optional(),
  })
  .describe("Move the in-game clock forward; effects tick");

export const RecordFactSchema = z
  .object({
    subject: id,
    statement: z.string().describe("A full sentence, e.g. 'The innkeeper is a cultist.'"),
    predicate: z.string().default(""),
    object: z.string().optional(),
    secret: z.boolean().default(false).describe("True if the player character doesn't know it"),
    knownBy: z.array(z.string()).default([]).describe("Who knows it; empty means everyone present"),
    importance: z.number().int().min(1).max(10).default(5),
    trait: z
      .object({ label: z.string(), bonus: z.number().int().min(-5).max(5) })
      .optional()
      .describe("Attach a check bonus to the subject (a skill or background)"),
  })
  .describe("Store a fact the prose may not say, usually a secret");

export const ThreadSchema = z
  .object({
    id: z.string().optional().describe("Existing thread id to update; omit to open a new one"),
    status: z.enum(["open", "progressing", "resolved", "failed", "abandoned"]),
    kind: z.enum(["quest", "promise", "debt", "mystery", "foreshadowing", "goal"]).default("quest"),
    title: z.string(),
    summary: z.string().default(""),
    entities: z.array(z.string()).default([]),
    hidden: z.boolean().default(false).describe("True for foreshadowing the player hasn't noticed"),
  })
  .describe("Open, update or resolve a quest, promise, mystery or piece of foreshadowing");

export const EndSceneSchema = z.object({ reason: z.string().default("") }).describe("Mark a scene boundary");

/** Changes that can appear inside a check's success or failure branch. */
export const ChangeSchema = z.discriminatedUnion("tool", [
  AdjustSchema.extend({ tool: z.literal("adjust") }),
  TransferSchema.extend({ tool: z.literal("transfer") }),
  MoveSchema.extend({ tool: z.literal("move") }),
  CreateSchema.extend({ tool: z.literal("create") }),
  AddStatusSchema.extend({ tool: z.literal("add_status") }),
  RemoveStatusSchema.extend({ tool: z.literal("remove_status") }),
  DefineStatSchema.extend({ tool: z.literal("define_stat") }),
  SetAliveSchema.extend({ tool: z.literal("set_alive") }),
  AdvanceTimeSchema.extend({ tool: z.literal("advance_time") }),
  RecordFactSchema.extend({ tool: z.literal("record_fact") }),
  ThreadSchema.extend({ tool: z.literal("thread") }),
  EndSceneSchema.extend({ tool: z.literal("end_scene") }),
]);
export type Change = z.infer<typeof ChangeSchema>;

export const CheckSchema = z
  .object({
    actor: id.default("player"),
    description: z.string().describe("What is attempted, e.g. 'Persuade Vyr'"),
    attribute: z.string().describe("body, agility, mind or presence"),
    traits: z.array(z.string()).default([]).describe("The actor's traits that apply"),
    difficulty: z.enum(DIFFICULTIES),
    onSuccess: z.array(ChangeSchema).default([]),
    onFailure: z.array(ChangeSchema).default([]),
  })
  .describe("Roll for an attempted action. Declare both outcomes before the roll.");

export const TOOL_SCHEMAS = {
  check: CheckSchema,
  adjust: AdjustSchema,
  transfer: TransferSchema,
  move: MoveSchema,
  create: CreateSchema,
  add_status: AddStatusSchema,
  remove_status: RemoveStatusSchema,
  define_stat: DefineStatSchema,
  set_alive: SetAliveSchema,
  advance_time: AdvanceTimeSchema,
  record_fact: RecordFactSchema,
  thread: ThreadSchema,
  end_scene: EndSceneSchema,
} as const;
export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export const ActionSchema = z.discriminatedUnion("tool", [
  CheckSchema.extend({ tool: z.literal("check") }),
  ...ChangeSchema.options,
]);
export type Action = z.infer<typeof ActionSchema>;
export type CheckAction = Extract<Action, { tool: "check" }>;

/** Parse one raw tool call (name + JSON args) into an action, or explain why not. */
export function parseToolCall(name: string, args: unknown): { ok: true; action: Action } | { ok: false; error: string } {
  if (!(name in TOOL_SCHEMAS)) return { ok: false, error: `Unknown tool '${name}'` };
  const r = ActionSchema.safeParse({ ...(args as object), tool: name });
  if (!r.success) return { ok: false, error: `${name}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { ok: true, action: r.data };
}

/** OpenAI-style function definitions for the chat API. */
export function toolDefinitions() {
  return TOOL_NAMES.map((name) => {
    const schema = z.toJSONSchema(TOOL_SCHEMAS[name], { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      type: "function" as const,
      function: { name, description: (TOOL_SCHEMAS[name] as z.ZodType).description ?? name, parameters: schema },
    };
  });
}
