/**
 * `plywood notify relay`: chant's relay (`chant notify relay`, chant#4611)
 * run in process with plywood's words. It receives an Approve click from
 * Slack or a reply in Teams on a waiting wave's message, checks the
 * platform's signature, the button's signature under the relay key, the
 * clicker against the signers file at base and the digest against the
 * standing pending gate, then records the approval on the workspace ledger
 * with `relayedBy` (`plywood-relay` unless CHANT_RELAY_PRINCIPAL says
 * otherwise). plywood.yml's `notify.relay` names the variable holding the
 * key; the relay reads it as CHANT_RELAY_KEY, with SLACK_SIGNING_SECRET or
 * TEAMS_WEBHOOK_SECRET.
 */
import type { ExitTable } from "./exit-codes";
import { usage, withChant, type StageIo } from "./stages";
import { PRODUCT, PRODUCT_WORDS } from "./words";

export async function notify(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  if (args[0] !== "relay") return usage(`unknown notify command '${args[0] ?? ""}'. Run '${PRODUCT} notify relay'.`, table, io);
  return withChant(`${PRODUCT} notify relay`, table, io, (chant) => chant.runChantInProcess(["notify", ...args], PRODUCT_WORDS));
}
