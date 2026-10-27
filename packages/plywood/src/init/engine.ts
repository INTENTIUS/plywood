/**
 * `plywood init --engine`: the engine step of init, kept in its own module
 * so `--engine plunge` grows here without touching the rest of init.
 *
 * Today the step writes `engine:` into plywood.yml when the flag names one.
 * With no flag it writes nothing, and chant's pulumi lexicon decides per
 * stack from a `plunge+` backend, PULUMI_BACKEND_URL or Pulumi.yaml
 * (chant#4559). The plunge setup (a `plunge+<same url>` per stack, the
 * bucket check against it, the per-stack adopt previews) lands in this
 * step's `plunge` branch.
 */
import type { RawConfig } from "../config/types";
import type { Detected } from "./detect";

export const INIT_ENGINES = ["pulumi", "plunge"] as const;
export type InitEngine = (typeof INIT_ENGINES)[number];

/** What the engine step hands back to init. */
export interface EngineStep {
  /** Keys for a new plywood.yml. */
  keys: RawConfig;
  /** Lines init prints under the files it wrote. */
  notes: string[];
}

export interface EngineStepInput {
  engine: InitEngine | undefined;
  detected: Detected;
  env: NodeJS.ProcessEnv;
}

/** The engine step for a new plywood.yml. */
export function engineStep(input: EngineStepInput): EngineStep {
  if (input.engine === undefined) return { keys: {}, notes: [] };
  if (input.engine === "pulumi") return { keys: { engine: "pulumi" }, notes: [] };
  return {
    keys: { engine: "plunge" },
    notes: [
      "engine: plunge is written. init does not yet give each stack its plunge+ backend URL or print the adopt previews;",
      "set backend: plunge+<your backend URL> in plywood.yml, and run plunge stack adopt for each stack before its first update.",
    ],
  };
}
