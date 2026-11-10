/**
 * `.chant/trust.json` for plywood.yml's `evidence` key, as `plywood init`
 * writes it. chant reads the file at base; plywood only fills in what
 * plywood.yml and the repository say:
 *
 *   keyless   with `evidence.identity: oidc`, the waves workflow's identity on
 *             the default branch, from chant's `ciRunnerIdentity` and
 *             `withRunnerIdentity` (chant#4869), its principal in roles.runner
 *   local     with `evidence.local: true`, the check hooks by name under
 *             `local.checks` (chant#4868); absent, no check takes local evidence
 *
 * A file already there is merged into: an identity or a local check it has
 * is kept as it is. Without `evidence` init writes no trust file.
 *
 * The ref gate's pieces are chant's (`refGateInitPlan` in
 * `@intentius/chant/ref-gate-init`, chant#4913): the `refs` rule for the
 * default branch, the `pre-push` hook and the runner key hint. plywood names
 * the rule's checks ({@link refGateChecks}).
 */
import type { RefGateInitCheck } from "@intentius/chant/ref-gate-init";
import { trustConfigSchema, type TrustConfig } from "@intentius/chant/workspace/trust/policy";
import { ciRunnerIdentity, DEFAULT_TRUSTED_ROOT_PATH, withRunnerIdentity } from "@intentius/chant/workspace/trust/runner-identity";
import type { PipelineEvidence } from "@intentius/chant/ci-evidence-jobs";
import type { ForgeKind } from "../chant-product";
import { WAVES_OUTPUT_DIR } from "../waves-workflow";
import { OP_NAME, PRODUCT } from "../words";

export const TRUST_FILE = ".chant/trust.json";

/** The command that produces each check the ref gate names, as its refusal prints it. */
export const CHECK_COMMAND = `${PRODUCT} check`;
export const PREVIEW_COMMAND = `/${PRODUCT} preview on the pull request`;

/**
 * The checks the ref gate's rule for the default branch needs evidence for:
 * the check hooks, then `plan` and `policy`. A check local evidence stands in
 * for has no runner evidence after CI skips it, so with `local` the rule
 * names no hook.
 */
export function refGateChecks(hooks: readonly string[], local: boolean): RefGateInitCheck[] {
  return [
    ...(local ? [] : hooks).map((check) => ({ check, command: CHECK_COMMAND })),
    { check: "plan", command: PREVIEW_COMMAND },
    { check: "policy", command: PREVIEW_COMMAND },
  ];
}

export interface TrustInput {
  forge: ForgeKind;
  /** `owner/repo`, or a GitLab project path, from the origin remote. */
  repository?: string;
  /** A self-hosted forge's base URL. */
  server?: string;
  /** The default branch, which the waves run on. */
  branch: string;
  evidence: { chant: PipelineEvidence; local: boolean };
  /** The check hooks by name, as `chant ci check` signs them. */
  hooks: string[];
}

export interface TrustResult {
  text: string;
  /** What is left for the person. */
  todo: string[];
}

/** The workflow file the waves' signing jobs run in, as the forge's certificate names it. */
export function signingWorkflow(forge: ForgeKind): string {
  return forge === "gitlab" ? ".gitlab-ci.yml" : `${WAVES_OUTPUT_DIR[forge]}/${OP_NAME}.yml`;
}

/** `.chant/trust.json`'s text for `input`, merged into `existing`. Throws when the result is not a trust config chant reads. */
export function trustText(existing: string | undefined, input: TrustInput): TrustResult {
  const todo: string[] = [];
  let text = existing;
  const ref = `refs/heads/${input.branch}`;
  if (input.evidence.chant.identity === "oidc") {
    if (input.forge === "forgejo") {
      todo.push(`Add the waves workflow's keyless identity to ${TRUST_FILE} (keyless.identities, with ci in roles.runner): a Forgejo job's certificate comes from the authority you run, so its issuer and subject are yours to name`);
    } else if (!input.repository) {
      todo.push(`Add the waves workflow's keyless identity to ${TRUST_FILE}: init read no repository from the origin remote`);
    } else {
      const identity = ciRunnerIdentity({ forge: input.forge, repository: input.repository, workflow: signingWorkflow(input.forge), ref, ...(input.server ? { server: input.server } : {}) });
      text = withRunnerIdentity(text, identity);
    }
    todo.push(`Put sigstore's trusted_root.json at ${DEFAULT_TRUSTED_ROOT_PATH}, which ${TRUST_FILE} names under keyless.trustedRoot; until it is there, no keyless evidence verifies`);
  }
  const config: TrustConfig = text === undefined || text.trim() === "" ? { schema: 1 } : (JSON.parse(text) as TrustConfig);
  const next: TrustConfig = { ...config };
  if (input.evidence.local && input.hooks.length > 0) {
    const local = config.local ?? {};
    const named = new Set((local.checks ?? []).map((c) => c.check));
    next.local = { ...local, checks: [...(local.checks ?? []), ...input.hooks.filter((h) => !named.has(h)).map((check) => ({ check }))] };
    if (!local.keys?.length) todo.push(`Add each person's ssh-ed25519 key under local.keys in ${TRUST_FILE}, so ${input.hooks.join(", ")} proven on their machine is skipped in CI`);
  }
  const parsed = trustConfigSchema.safeParse(next);
  if (!parsed.success) throw new Error(`${TRUST_FILE} with plywood.yml's evidence is not a trust config chant reads: ${parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
  return { text: `${JSON.stringify(next, null, 2)}\n`, todo };
}
