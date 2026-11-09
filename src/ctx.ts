import type { Config } from "./config.ts";
import type { DB } from "./db/db.ts";
import type { LLM } from "./llm/client.ts";

/** Everything a pipeline step needs: the campaign database, the models and the config. */
export interface Ctx {
  db: DB;
  llm: LLM;
  config: Config;
}
