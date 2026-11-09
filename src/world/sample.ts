import type { GeneratedWorld } from "./generate.ts";

/**
 * A small fixed world: used by the offline provider, the tests, and the scripted eval
 * campaigns (so scripted inputs can name its people and places in any mode).
 */
export function sampleWorld(name = "Ash", concept = ""): GeneratedWorld {
  return {
    frame: {
        title: "The Ember Vale",
        genre: "low fantasy",
        tone: "grounded, warm, with danger at the edges",
        themes: ["debts and promises", "old secrets"],
        rules: ["Magic is rare and costs the caster something.", "The dead do not return without a price paid to the Hollow Saint."],
        summary: "A valley of farming villages under a fading duchy. Bandits grow bold, and the old tower to the north is said to be haunted.",
      },
    geography: {
        regions: [
          {
            name: "The Ember Vale",
            description: "A green valley of farms and forges.",
            starting: true,
            places: [
              { name: "Oakvale", kind: "village", description: "A village of thatched roofs around a square well.", stub: false },
              { name: "The Rusty Anvil", kind: "smithy", description: "Mira's forge, hot and loud, on Oakvale's square.", stub: false },
              { name: "The Sleeping Fox", kind: "inn", description: "A low inn with a fire that never goes out.", stub: false },
              { name: "The Ruined Tower", kind: "tower", description: "A broken tower on the northern ridge.", stub: true },
            ],
          },
          { name: "The Grey Marches", description: "Moors to the east, named but unexplored.", starting: false, places: [] },
        ],
      },
    factions: {
        factions: [
          { name: "The Duke's Wardens", description: "The thinly spread law of the valley.", wants: "to keep the roads open", base: "Oakvale", relations: [{ other: "The Red Hands", stance: "open war" }] },
          { name: "The Red Hands", description: "A bandit company.", wants: "to tax every cart that passes", base: "The Grey Marches", relations: [] },
        ],
      },
    history: {
        events: [{ statement: "Twenty years ago a fire gutted the Ruined Tower.", importance: 6 }, { statement: "The old duke died last winter.", importance: 5 }],
        tensions: ["The Red Hands have started raiding farms near Oakvale."],
      },
    npcs: {
        npcs: [
          { name: "Mira", aliases: ["the blacksmith", "the old smith"], role: "the blacksmith of Oakvale", description: "Broad-shouldered, grey-haired, blunt.", location: "The Rusty Anvil", goal: "to pay off her brother's debts", faction: null, relationships: [{ other: "Tomas", relation: "her younger brother" }], secrets: ["Mira's brother Tomas sold the player's map to the Red Hands."], toughness: "moderate" },
          { name: "Vyr", aliases: ["the innkeeper"], role: "the innkeeper of the Sleeping Fox", description: "Thin, watchful, quick to smile.", location: "The Sleeping Fox", goal: "to learn every secret in the valley", faction: null, relationships: [], secrets: ["Vyr is an informant for the Red Hands."], toughness: "minor" },
          { name: "Tomas", aliases: [], role: "Mira's brother, a gambler", description: "Charming and always broke.", location: "The Sleeping Fox", goal: "to win back what he lost", faction: null, relationships: [{ other: "Mira", relation: "his older sister" }], secrets: [], toughness: "minor" },
          { name: "Captain Hale", aliases: ["the captain"], role: "captain of the Duke's Wardens", description: "Tired, honest, outnumbered.", location: "Oakvale", goal: "to break the Red Hands", faction: "The Duke's Wardens", relationships: [], secrets: [], toughness: "major" },
        ],
      },
    start: {
        location: "Oakvale",
        locationDescription: "Oakvale's square at morning: the well, the smithy's smoke, the inn's sign creaking.",
        scene: "You arrive in Oakvale with a map that has just been stolen, and the smith's hammer is the only sound on the square.",
        threads: [
          { kind: "mystery", title: "Who stole the map", summary: "Your map to the Ruined Tower was stolen on the road.", hiddenTruth: "Tomas sold the map to the Red Hands to cover a gambling debt.", entities: ["Tomas"] },
          { kind: "quest", title: "The Ruined Tower", summary: "Something waits in the Ruined Tower.", hiddenTruth: null, entities: ["The Ruined Tower"] },
        ],
      },
    character: {
        name,
        description: concept || "A wandering sellsword.",
        attributes: { body: "good", agility: "average", mind: "average", presence: "good" },
        traits: [{ label: "ex-sailor", bonus: 2 }],
        wealth: "modest",
        inventory: [{ name: "Short sword", quantity: 1, description: "Notched but sharp." }, { name: "Wolf pelt", quantity: 3, description: "" }],
        background: [`${name} was a sailor before taking up the sword.`, `${name} is looking for the Ruined Tower.`],
      },
    consistency: { problems: [] },
  } as GeneratedWorld;
}
