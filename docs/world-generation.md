# World generation

The world is generated at the start, then filled in as the player explores. Both follow the same rule: new content must fit what already exists.

## At the start

The player gives a premise (genre, tone, setting, anything) and a character concept. Generation runs as a chain of steps. Each step returns validated JSON and sees the results of the steps before it.

1. **Frame:** genre, tone, themes, and the world's rules: how magic or technology works, what is and isn't possible. This is what keeps everything later consistent.
2. **Geography:** regions. The starting region in detail, the rest as stubs.
3. **Factions:** who holds power, what they want, how they relate to each other.
4. **History and tensions:** a few key past events and what's unstable now.
5. **Key NPCs (5–15):** goals, relationships and secrets.
6. **Starting point:** the starting location in detail and 2–3 opening threads, including at least one hidden truth behind a mystery.
7. **Player character:** attributes from the concept as labels (the engine assigns the numbers), starting traits, inventory and background facts.

Then:
- Everything is stored as entities, `canon` facts, threads and secrets.
- A **consistency pass** by the `verifier` checks the world for internal contradictions before play starts.
- The frame and rules are kept short (~1–2k tokens) so they fit in every prompt's cached prefix. Everything else is retrieved when relevant.

## While playing

- **Stubs are filled on first touch.** Canon can name things without detail ("a ruined tower to the north"). The first time the player goes there, asks about it or meets someone from there, the planner generates the details, which must respect the stub.
- **New content goes through the normal tools** (`create`, `record_fact`, `thread`), with the relevant canon retrieved: the region, the factions, the world's rules.
- **The usual contradiction checks apply.** A new detail that contradicts canon is rejected and the planner retries.
- **Generated details are permanent.** Once the tower has three floors, it has three floors.
- **Canon changes only through events.** The king can die (an update). "There never was a king" is a contradiction and is rejected.

## Later (not in the first build)

The world moving on its own: when significant time passes, factions and NPCs off-screen advance their goals.
