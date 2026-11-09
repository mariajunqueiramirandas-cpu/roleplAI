/**
 * Campaign database schema. One SQLite file per campaign doubles as the save file.
 *
 * Three groups of tables:
 *  - the tree: segments, turns, events, lineage, slots, snapshots
 *  - projections (p_*): current hard state, rebuilt from events at any time
 *  - memory: aliases, facts, knowledge, episodes, summaries, embeddings...
 *    Every memory row carries (segment, turn) and is visible only on its timeline.
 */
export function migrations(dims: number): string[] {
  return [
    `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE segments (
      id INTEGER PRIMARY KEY,
      parent INTEGER,
      fork_turn INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE turns (
      id INTEGER PRIMARY KEY,
      segment INTEGER NOT NULL,
      parent INTEGER,
      scene INTEGER NOT NULL DEFAULT 0,
      game_time INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,              -- genesis | play | ooc
      input TEXT NOT NULL DEFAULT '',
      intent TEXT,                      -- json
      plan TEXT,                        -- json
      outcome TEXT,                     -- json
      prose TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 3,
      extracted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX turns_seg ON turns(segment, id);
    CREATE INDEX turns_parent ON turns(parent);

    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      turn INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      game_time INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX events_seg ON events(segment, turn);

    CREATE TABLE lineage (segment INTEGER PRIMARY KEY, max_turn INTEGER NOT NULL);
    CREATE TABLE slots (name TEXT PRIMARY KEY, turn INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      turn INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      last_event INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    -- Projections: current hard state on the current timeline
    CREATE TABLE p_entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT,
      alive INTEGER NOT NULL DEFAULT 1,
      stub INTEGER NOT NULL DEFAULT 0,
      profile TEXT NOT NULL DEFAULT '',
      merged_into TEXT,
      created_turn INTEGER NOT NULL
    );
    CREATE INDEX p_entities_loc ON p_entities(location);
    CREATE TABLE p_stats (
      entity TEXT NOT NULL,
      name TEXT NOT NULL,
      toward TEXT NOT NULL DEFAULT '',
      value REAL NOT NULL,
      max REAL,
      category TEXT NOT NULL,          -- core | attribute | custom
      PRIMARY KEY (entity, name, toward)
    );
    CREATE TABLE p_holdings (
      holder TEXT NOT NULL,
      item TEXT NOT NULL,
      qty INTEGER NOT NULL,
      PRIMARY KEY (holder, item)
    );
    CREATE TABLE p_statuses (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      label TEXT NOT NULL,
      effects TEXT NOT NULL DEFAULT '[]',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      last_tick INTEGER NOT NULL
    );
    CREATE TABLE p_traits (
      entity TEXT NOT NULL,
      label TEXT NOT NULL,
      bonus INTEGER NOT NULL,
      PRIMARY KEY (entity, label)
    );
    CREATE TABLE p_threads (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      entities TEXT NOT NULL DEFAULT '[]',
      hidden INTEGER NOT NULL DEFAULT 0,
      opened_turn INTEGER NOT NULL,
      updated_turn INTEGER NOT NULL,
      updated_time INTEGER NOT NULL
    );
    CREATE TABLE p_world (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- Memory
    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY,
      entity TEXT NOT NULL,
      alias TEXT NOT NULL,
      norm TEXT NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );
    CREATE INDEX aliases_norm ON aliases(norm);
    CREATE INDEX aliases_entity ON aliases(entity);

    CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL DEFAULT '',
      object TEXT,
      statement TEXT NOT NULL,
      valid_from_time INTEGER NOT NULL,
      valid_from_turn INTEGER NOT NULL,
      authority TEXT NOT NULL,          -- state | canon | narrative | inferred
      importance INTEGER NOT NULL DEFAULT 5,
      secret INTEGER NOT NULL DEFAULT 0,
      source INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );
    CREATE INDEX facts_subject ON facts(subject);
    CREATE INDEX facts_object ON facts(object);

    -- Closing a fact is its own row, so a fact closed on one timeline stays open on another.
    CREATE TABLE fact_closures (
      id INTEGER PRIMARY KEY,
      fact INTEGER NOT NULL,
      valid_to_time INTEGER NOT NULL,
      valid_to_turn INTEGER NOT NULL,
      superseded_by INTEGER,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );
    CREATE INDEX fact_closures_fact ON fact_closures(fact);

    CREATE TABLE fact_sources (
      id INTEGER PRIMARY KEY,
      fact INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );

    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY,
      item_type TEXT NOT NULL,          -- fact | episode
      item INTEGER NOT NULL,
      entity TEXT NOT NULL,             -- '*' = common knowledge
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );
    CREATE INDEX knowledge_item ON knowledge(item_type, item);
    CREATE INDEX knowledge_entity ON knowledge(entity);

    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      scene INTEGER NOT NULL,
      summary TEXT NOT NULL,
      participants TEXT NOT NULL,       -- json array of entity ids
      place TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      start_turn INTEGER NOT NULL,
      end_turn INTEGER NOT NULL,
      importance INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );

    CREATE TABLE summaries (
      id INTEGER PRIMARY KEY,
      level TEXT NOT NULL,              -- chapter | arc | saga (scene level = episodes)
      text TEXT NOT NULL,
      start_turn INTEGER NOT NULL,
      end_turn INTEGER NOT NULL,
      children TEXT NOT NULL,           -- json array of child ids (episodes or summaries)
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );

    CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE conflicts (
      id INTEGER PRIMARY KEY,
      fact_a INTEGER NOT NULL,
      fact_b INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );
    CREATE TABLE conflict_resolutions (
      id INTEGER PRIMARY KEY,
      conflict INTEGER NOT NULL,
      resolution TEXT NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );

    CREATE TABLE drift_log (
      id INTEGER PRIMARY KEY,
      turn INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      statement TEXT NOT NULL,
      against INTEGER,
      reason TEXT NOT NULL
    );

    CREATE TABLE reflections (
      id INTEGER PRIMARY KEY,
      entity TEXT NOT NULL,
      upto_episode INTEGER NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );

    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY,
      item_type TEXT NOT NULL,          -- fact | episode | profile
      item TEXT NOT NULL,
      model TEXT NOT NULL,
      segment INTEGER NOT NULL,
      turn INTEGER NOT NULL
    );
    CREATE INDEX embeddings_item ON embeddings(item_type, item);
    CREATE VIRTUAL TABLE vec_items USING vec0(id INTEGER PRIMARY KEY, embedding float[${dims}] distance_metric=cosine);

    CREATE VIRTUAL TABLE facts_fts USING fts5(statement, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE episodes_fts USING fts5(summary, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE turns_fts USING fts5(text, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE names_fts USING fts5(alias, tokenize='unicode61');

    CREATE TABLE llm_calls (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      turn INTEGER,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      tokens_cached INTEGER,
      cost REAL,
      latency_ms INTEGER,
      repaired INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE token_calibration (
      model TEXT PRIMARY KEY,
      ratio REAL NOT NULL,
      samples INTEGER NOT NULL
    );
    `,
  ];
}
