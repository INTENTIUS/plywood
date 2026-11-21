/**
 * `plywood pause <env>` and `plywood resume <env>` (plywood#156): chant's
 * `stage pause` and `stage resume` (chant#5355) on an environment of
 * `promotion`, with plywood's words. A paused stage takes no release: a
 * promote into it exits 3 and its release waits; the resume lets the newest
 * release that waited in. Each writes a line on the stage's ledger naming
 * who and why. `plywood reject` is chant's `reject` (chant#5354), passed
 * through (src/stages.ts `CHANT_PASSTHROUGH`).
 */
import type { ExitTable } from "./exit-codes";
import { promotionOf } from "./config/promotion";
import { checkConfig, findConfig, loadConfig } from "./config/index";
import { positionals, takeFlag, usage, withChant, type StageIo } from "./stages";
import { PRODUCT, PRODUCT_WORDS, STAGE_WORDS } from "./words";

/** `plywood pause|resume <env> --reason <text> [--actor <who>]`. */
export async function stageCommand(verb: "pause" | "resume", args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const reason = takeFlag(args, "--reason");
  const actor = takeFlag(reason.rest, "--actor");
  if (reason.missing || actor.missing) return usage("--reason and --actor each take a value", table, io);
  const extra = actor.rest.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`${verb} does not take ${extra.join(" ")}`, table, io);
  const named = positionals(actor.rest);
  if (named.length !== 1) return usage(STAGE_WORDS.usage[verb], table, io);
  if (!reason.value) return usage(`${verb} says why: ${STAGE_WORDS.usage[verb]}`, table, io);
  const env = named[0]!;
  const path = findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init' first`, table, io);
  const config = loadConfig(path);
  if (checkConfig(config).some((p) => p.severity === "error")) return usage(`${path} does not check; run '${PRODUCT} config check'`, table, io);
  const promotion = promotionOf(config.doc);
  if (!promotion) return usage(STAGE_WORDS.noPromotion(path), table, io);
  if (!promotion.includes(env)) return usage(STAGE_WORDS.notAStage(env, promotion), table, io);
  const argv = ["stage", verb, env, "--reason", reason.value, ...(actor.value ? ["--actor", actor.value] : []), ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} ${verb}`, table, io, (chant) => chant.runChantInProcess(argv, PRODUCT_WORDS));
}
