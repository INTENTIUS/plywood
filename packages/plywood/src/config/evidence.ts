/**
 * `evidence`: the runner identity the generated pipelines sign check
 * evidence with (chant#4870, #4869), and whether plywood's check hooks take
 * local evidence (chant#4868).
 *
 *   evidence.identity oidc           evidence: { identity: "oidc" }      keyless, from the job's OIDC token
 *   evidence.audience <aud>          evidence.audience                   with identity; default chant's (sigstore)
 *   evidence.runner_key_secret NAME  evidence: { runnerKeySecret: NAME } the secret holding the runner key
 *   evidence.local true              init names the check hooks under   default false: no check takes local
 *                                    `local.checks` in .chant/trust.json evidence
 *
 * chant's `evidence` option goes on the productPipelineJobs call
 * (src/stages.ts `workflowPlan`) and into the waves spec's options
 * (src/waves-workflow.ts), so each deciding wave job signs `plan:<wave>` and
 * `policy:<wave>`. `plywood check` runs `chant ci check`, which signs each
 * check hook by its name when the job has `CHANT_RUNNER_KEY` or
 * `CHANT_RUNNER_IDENTITY=oidc`. `plywood init` writes `.chant/trust.json`
 * from the key (src/init/trust.ts). Without the key nothing changes.
 */
import type { PipelineEvidence } from "@intentius/chant/ci-evidence-jobs";
import { error, isObject, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

export const EVIDENCE_KEYS = ["identity", "audience", "runner_key_secret", "local"] as const;

/** A secret or CI/CD variable name, as chant's `assertPipelineEvidence` takes it. */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `evidence` as read: chant's option, and whether the check hooks take local evidence. Undefined without the key. */
export function evidenceOf(doc: RawConfig): { chant: PipelineEvidence; local: boolean } | undefined {
  const e = doc.evidence;
  if (!isObject(e)) return undefined;
  const chant: PipelineEvidence =
    e.identity === "oidc"
      ? { identity: "oidc", ...(typeof e.audience === "string" ? { audience: e.audience } : {}) }
      : { runnerKeySecret: String(e.runner_key_secret) };
  return { chant, local: e.local === true };
}

export const evidence: ConfigGroup = {
  name: "evidence",
  keys: ["evidence"],
  schema: {
    evidence: {
      type: "object",
      additionalProperties: false,
      description: "The runner identity the generated pipelines sign check evidence with: identity oidc, or runner_key_secret. Absent: nothing is signed.",
      properties: {
        identity: { type: "string", enum: ["oidc"], description: "oidc: sign keyless from each job's OIDC token, as .chant/trust.json lists the workflow under keyless.identities." },
        audience: { type: "string", description: "With identity: the OIDC token's audience. Default chant's, sigstore." },
        runner_key_secret: { type: "string", pattern: SECRET_NAME.source, description: "The secret (GitHub, Forgejo) or CI/CD variable (GitLab) holding the runner key, whose public half .chant/trust.json lists under runners." },
        local: { type: "boolean", default: false, description: "true: plywood init names the check hooks under local.checks in .chant/trust.json, so a hook proven on a person's machine is skipped in CI." },
      },
    },
  },
  check(doc) {
    const e = doc.evidence;
    if (e === undefined) return [];
    if (!isObject(e)) return [error("evidence", "must be a mapping with identity or runner_key_secret")];
    const out: ConfigProblem[] = [...onlyKeys(e, EVIDENCE_KEYS, "evidence")];
    if (e.identity !== undefined && e.identity !== "oidc") out.push(error("evidence.identity", `is ${JSON.stringify(e.identity)}; oidc is the one identity chant signs keyless with`));
    if (e.identity !== undefined && e.runner_key_secret !== undefined) out.push(error("evidence", "sets identity and runner_key_secret; a pipeline signs with one of them"));
    if (e.identity === undefined && e.runner_key_secret === undefined) out.push(error("evidence", "sets neither identity nor runner_key_secret; give one, or leave evidence out"));
    if (e.runner_key_secret !== undefined && (typeof e.runner_key_secret !== "string" || !SECRET_NAME.test(e.runner_key_secret))) {
      out.push(error("evidence.runner_key_secret", "must be a secret name: letters, digits and _, not starting with a digit"));
    }
    if (e.audience !== undefined) {
      if (e.identity === undefined) out.push(error("evidence.audience", "goes with identity: oidc"));
      else if (typeof e.audience !== "string" || !/^[\x21-\x7e]+$/.test(e.audience)) out.push(error("evidence.audience", "must be printable ASCII with no space"));
    }
    if (e.local !== undefined && typeof e.local !== "boolean") out.push(error("evidence.local", "must be true or false"));
    return out;
  },
  translate(doc, out) {
    const e = evidenceOf(doc);
    if (e) out.pipeline.evidence = e.chant;
  },
};
