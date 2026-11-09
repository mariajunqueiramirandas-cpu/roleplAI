import type { Effect } from "./tools.ts";

/**
 * Every hard change is one of these. Payloads hold resolved, absolute values
 * (not labels), so replaying the log always rebuilds identical state.
 */
export type GameEvent =
  | {
      type: "entity_created";
      id: string;
      kind: string;
      name: string;
      description: string;
      location: string | null;
      alive: boolean;
      stub: boolean;
    }
  | { type: "stat_set"; entity: string; stat: string; toward: string; value: number; max: number | null; category: string; delta?: number; reason?: string }
  | { type: "holding_set"; holder: string; item: string; qty: number; delta?: number }
  | { type: "moved"; entity: string; from: string | null; to: string }
  | { type: "status_added"; id: string; entity: string; label: string; effects: Effect[]; expiresAt: number | null }
  | { type: "status_ticked"; id: string; at: number }
  | { type: "status_removed"; id: string; reason: string }
  | { type: "trait_added"; entity: string; label: string; bonus: number }
  | { type: "alive_set"; entity: string; alive: boolean; cause: string }
  | { type: "time_set"; from: number; to: number }
  | {
      type: "thread_set";
      id: string;
      kind: string;
      title: string;
      status: string;
      summary: string;
      entities: string[];
      hidden: boolean;
    }
  | { type: "scene_started"; scene: number; reason: string; location: string | null }
  | { type: "check_rolled"; actor: string; description: string; attribute: string; difficulty: string; roll: number; bonus: number; total: number; target: number; success: boolean }
  | { type: "stub_filled"; entity: string }
  | { type: "profile_set"; entity: string; profile: string }
  | { type: "entities_merged"; from: string; into: string }
  | { type: "described"; entity: string; description: string }
  | { type: "world_set"; key: string; value: string };

export type EventType = GameEvent["type"];

export interface StoredEvent {
  id: number;
  turn: number;
  segment: number;
  game_time: number;
  type: EventType;
  payload: string;
}
