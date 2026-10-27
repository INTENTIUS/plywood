/**
 * `plywood config check`: reads the nearest plywood.yml (or `--file`),
 * prints each problem, and for a clean config the settings in force: the
 * engine plywood.yml names, when an update runs, the gate, the approval mode,
 * and when locks are taken at which grain. `--json` prints the chant
 * settings plywood would hand chant as well.
 */
import { toChantSettings } from "./chant-config";
import { applyWhenOf } from "./config/apply";
import { approvalOf, gateOf } from "./config/approval";
import { engineOf } from "./config/engine";
import { checkConfig, ConfigError, findConfig, loadConfig, type PlywoodConfig } from "./config/index";
import { LATER_KEYS } from "./config/later";
import { LOCK_GRAIN_OF, CI_LOCKS_OF, locksOf } from "./config/locks";
import { chantPolicyOf, policyPacksOf } from "./config/policy";
import type { RawConfig } from "./config/types";
import { PRODUCT } from "./words";

export interface ConfigCheckResult {
  ok: boolean;
  /** The text lines to print; problems go to stderr when not ok. */
  lines: string[];
  envelope: Record<string, unknown>;
}

/** Runs the check from `cwd`, or on `file` when given. */
export function configCheck(cwd: string, file?: string): ConfigCheckResult {
  const path = file ?? findConfig(cwd);
  if (!path) {
    const message = `no plywood.yml in ${cwd} or above it up to the repository root; run '${PRODUCT} init', or pass --file`;
    return { ok: false, lines: [message], envelope: { error: message } };
  }
  let config: PlywoodConfig;
  try {
    config = loadConfig(path);
  } catch (e) {
    const message = e instanceof ConfigError ? e.message : `${path}: ${(e as Error).message}`;
    return { ok: false, lines: [message], envelope: { file: path, error: message } };
  }
  const problems = checkConfig(config);
  const errors = problems.filter((p) => p.severity === "error");
  const lines = problems.map((p) => `${path}: ${p.key} ${p.message}${p.severity === "warning" ? " (warning)" : ""}`);
  if (errors.length) return { ok: false, lines, envelope: { file: path, problems } };

  const doc = config.doc;
  const engine = engineOf(doc);
  const locks = locksOf(doc);
  const later = Object.keys(doc).filter((k) => k in LATER_KEYS);
  const settings = {
    engine: engine?.engine ?? null,
    applyWhen: applyWhenOf(doc),
    gate: gateOf(doc),
    approval: approvalOf(doc),
    locksWhen: locks.when,
    lockGrain: locks.grain,
  };
  lines.push(
    `${path}: ok`,
    `  engine       ${engine ? `${engine.engine} (${engine.because})` : "not set here; chant reads PULUMI_BACKEND_URL, then Pulumi.yaml"}`,
    `  apply.when   ${settings.applyWhen}`,
    `  gate         ${settings.gate}`,
    `  approval     ${settings.approval}`,
    `  locks.when   ${locks.when} (ci.locks ${CI_LOCKS_OF[locks.when]})`,
    `  locks.grain  ${locks.grain} (ci.lockGrain ${LOCK_GRAIN_OF[locks.grain]})`,
    `  policy       ${policyLine(doc)}`,
    ...(later.length ? [`  read as written, not yet passed to chant: ${later.join(", ")}`] : []),
  );
  return { ok: true, lines, envelope: { file: path, problems, settings, chant: toChantSettings(config) } };
}

/** What plywood.yml's policy key switches on, for the settings line. */
function policyLine(doc: RawConfig): string {
  const rego = chantPolicyOf(doc);
  const packs = policyPacksOf(doc);
  const parts = [
    ...(rego ? [`Rego in ${rego.path ?? "policy"} (${rego.engine ?? "conftest"}), read at base`] : []),
    ...(packs.length ? [`CrossGuard ${packs.map((p) => p.dir).join(", ")} in each preview`] : []),
  ];
  return parts.length ? parts.join("; ") : "none";
}
