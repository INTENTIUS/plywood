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
 *
 * On a chant without the relay the command says so and exits with chant's
 * `failed` code.
 */
import type { ExitTable } from "./exit-codes";
import { usage, withChant, type StageIo } from "./stages";
import { PRODUCT, PRODUCT_WORDS } from "./words";

export const RELAY_NEEDS_CHANT = `${PRODUCT} notify relay needs chant >= the release after 0.124.54, which carries chant notify relay (chant#4611).`;

export async function notify(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  if (args[0] !== "relay") return usage(`unknown notify command '${args[0] ?? ""}'. Run '${PRODUCT} notify relay'.`, table, io);
  return withChant(`${PRODUCT} notify relay`, table, io, (chant) => {
    if (typeof chant.startRelayServer !== "function") {
      if (json) io.out(JSON.stringify({ command: "notify relay", ok: false, exitCode: table.failed, error: RELAY_NEEDS_CHANT }));
      else io.err(`${PRODUCT}: ${RELAY_NEEDS_CHANT}`);
      return Promise.resolve(table.failed);
    }
    return chant.runChantInProcess(["notify", ...args], PRODUCT_WORDS);
  });
}
