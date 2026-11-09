# State

## Hard core vs soft state

| | Hard core | Soft state |
|---|---|---|
| What | HP, mana, level/XP, gold, inventory, location, alive/dead, in-game time, attributes | Everything else: descriptions, relationships, curses, rumors, secrets, custom stats |
| Who changes it | The engine only, through validated tool calls | Planner tools, or extraction from the prose |
| Checked by | Hard rules | Contradiction checks against what's already known |
| Can stop an action? | Yes, as "here's the truth" (see rule 3 in [architecture.md](architecture.md)) | Never |

The AI can invent anything without code changes. A curse, a new stat or a dragon mount is stored as soft state, and only becomes hard if a mechanic is attached to it.

## Story mode (default)

Every hard-core value is tracked exactly, but only these rules are enforced:

1. HP and mana stay between 0 and their maximum. Gold and item counts never go below 0.
2. You can't spend, give or use what you don't have.
3. An entity is in exactly one place at a time.
4. The dead stay dead unless an explicit event revives them.
5. In-game time only moves forward.

At 0 HP the player is **downed**, not dead. The planner must turn it into a story event (captured, rescued, wakes up hurt). Permanent death only if the player turns it on.

Crunchy mode (later, not built now) adds encumbrance, ammo, spell slots and stricter checks on the same engine.

## Labels, not numbers

The model makes judgment calls; the engine turns them into numbers. This stops the model from inventing or fudging values and keeps game balance in one place.

| Model picks | Engine maps it to |
|---|---|
| Difficulty: `trivial`, `easy`, `medium`, `hard`, `very_hard`, `extreme` | A target number |
| Severity of damage, healing or mana: `minor`, `moderate`, `major`, `massive` | Dice scaled by level |
| Reward size: `small`, `fair`, `large`, `huge` | Gold or XP scaled by level |

Exact amounts are allowed only when the story names them, such as a price ("the sword costs 40 gold"). Rule 2 still applies.

## Checks

`d20 + attribute modifier + trait and status bonuses` against the difficulty's target number.

- **Attributes:** a small fixed set, by default `body`, `agility`, `mind`, `presence`. Tunable.
- **Traits:** free-text skills and backgrounds with a bonus ("ex-sailor +2", "fire-touched +1"). Created like any soft fact, with a bonus attached.
- Any action can be a check, however strange. The planner chooses the attribute, the relevant traits and the difficulty.

## The planner's tools

Every hard change and every deliberate world fact goes through one of these. They are deliberately few and generic.

| Tool | Does |
|---|---|
| `check` | Roll for an attempted action. Carries `onSuccess` and `onFailure` lists of the changes below |
| `adjust` | Change any stat (core or custom) by a severity label or an amount |
| `transfer` | Move gold or items between two holders. `world` as a holder creates or destroys them |
| `move` | Put an entity in a location |
| `create` | New entity. `kind` is free text: NPC, place, item, faction, disease, religion... |
| `add_status` / `remove_status` | Free-text status ("cursed: speaks only in rhymes") with optional duration and effects |
| `define_stat` | New custom stat on any entity ("sanity 10/10", "Vyr's patience 5/5") |
| `set_alive` | Death or revival, with a cause |
| `advance_time` | Move the clock; effects tick |
| `record_fact` | Store a fact the prose may not say, usually a secret ("the innkeeper is a cultist"), with who knows it |
| `thread` | Open, update or resolve a quest, promise, mystery or piece of foreshadowing |
| `end_scene` | Mark a scene boundary |

Relationship values (trust, fear, affection) are custom stats on a pair: `(npc, toward)`.

## Effects

Statuses can carry effects from a fixed set of generic patterns, so new mechanics need no new code:

- **Periodic change:** `−1 sanity per hour while in the fog`
- **Check modifier:** `+2 to presence checks`
- **Max modifier:** `max HP −5 while poisoned`
- **Expiry:** after a duration, at a game time, or when removed

Anything more complex stays narrative: remembered as a soft fact and interpreted by the model.

## Event log

- Every change is an event: `{ id, turn, segment, game_time, type, payload }`. Events are never edited.
- Current hard state lives in projection tables, updated in the same transaction as the event. Projections can always be rebuilt by replaying events, and are snapshotted every N turns so rebuilds are fast.
- A turn is one player input and everything that resulted from it. Undo means moving back to an earlier turn.

## Branches

- Turns form a tree: each turn has a parent. Save slots and rewinds are pointers into the tree.
- Acting from an earlier turn starts a new **segment**. A timeline is a chain of segments, each one running up to the turn where the next one forked.
- Every stored row (events, facts, episodes, embeddings) carries `(segment, turn)`. A row is visible only if it's on the current timeline; queries join a small `lineage` table rebuilt when the timeline changes.
- Switching timelines rebuilds hard-state projections from the nearest snapshot. Memory needs no rebuild: the lineage filter hides the other timelines.
