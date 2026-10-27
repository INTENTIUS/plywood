/**
 * `policy`: Rego rules over the change set and CrossGuard policy packs, both
 * in the preview job and both feeding chant's gate (plywood#13, ruling 7).
 *
 *   policy.rego       ci.policy.path   a directory of Rego rules, read at base
 *   policy.engine     ci.policy.engine conftest (default) or opa, the result shape
 *   policy.namespace  ci.policy.namespace
 *   policy.command    ci.policy.command argv in place of the engine's own
 *   policy.packs      each stack's pulumi-up step `policyPacks` (chant#4541):
 *                     the preview and the update run `--policy-pack <dir>`
 *
 * chant reads the Rego rules from the declaration at base (chant#4294), so a
 * rule changed on the head branch does nothing to its own pull request. A
 * `deny` rule denies the preview and a `hold` rule waits for a person; there
 * is no unattended outcome, since a non-empty change always waits for one.
 *
 * A CrossGuard pack's `mandatory` violations deny and its `advisory` ones are
 * note lines: chant's pulumi lexicon reads both from the streamed preview
 * (`pulumiPolicyFindings`, chant#4541) and names each rule
 * `crossguard.<pack>.<policy>`, the id `plywood override --rule` takes.
 * Either kind of denial exits with chant's `denied` code, 7.
 */
import { posix } from "node:path";
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

/** chant's result shapes (`GATE_POLICY_ENGINES`, @intentius/chant/gate-policy). */
export const POLICY_ENGINES = ["conftest", "opa"] as const;
export type PolicyEngine = (typeof POLICY_ENGINES)[number];

export const POLICY_KEYS = ["rego", "engine", "namespace", "command", "packs"] as const;
export const PACK_KEYS = ["dir", "config"] as const;

/** Keys a reader of terragucci's `policy` or Pulumi Deployments may reach for, and why plywood has none. */
const NO_SUCH_KEY: Readonly<Record<string, string>> = {
  allow_unattended: "chant's gate denies and holds only; a non-empty change always waits for a person, so there is no unattended outcome",
  outcomes: "a Rego rule's name sets its outcome: deny_* denies, hold_* holds, warn_* is a note line",
  source: "a shared policy source from a git ref is not in chant's ci.policy yet; vendor the rules into the repository, where they are read at base",
};

/** chant's `ci.policy` (`GatePolicySettings`). */
export interface ChantPolicySettings {
  engine?: PolicyEngine;
  path?: string;
  namespace?: string;
  command?: string[];
}

/** One CrossGuard pack, as the pulumi-up step takes it (chant `PulumiPolicyPack`). */
export interface PolicyPack {
  dir: string;
  config?: string;
}

/** A path inside the repository, relative to its root: no leading `/`, no `..`, not a flag. */
function repoPath(v: unknown, key: string): ConfigProblem[] {
  if (typeof v !== "string" || v.trim() === "") return [error(key, "is a path inside the repository")];
  if (v.startsWith("/") || v.startsWith("-") || v.split("/").includes("..")) return [error(key, `is ${JSON.stringify(v)}; give a path relative to the repository root, inside it`)];
  return [];
}

/** A path with `./` and trailing slashes taken off, as chant compares paths. */
export function cleanPath(p: string): string {
  const out = posix.normalize(p).replace(/\/+$/, "");
  return out === "" ? "." : out;
}

/** The packs plywood.yml lists, each as `{ dir, config? }`. */
export function policyPacksOf(doc: RawConfig): PolicyPack[] {
  const packs = isObject(doc.policy) && Array.isArray(doc.policy.packs) ? doc.policy.packs : [];
  return packs.flatMap((p): PolicyPack[] => {
    if (typeof p === "string") return [{ dir: cleanPath(p) }];
    if (isObject(p) && typeof p.dir === "string") return [{ dir: cleanPath(p.dir), ...(typeof p.config === "string" ? { config: cleanPath(p.config) } : {}) }];
    return [];
  });
}

/**
 * A stack's packs with each path relative to the stack's directory, since
 * the engine runs there: `policy/guard` for a stack in `infra` is
 * `../policy/guard`.
 */
export function packsForStack(packs: readonly PolicyPack[], stackDir: string): PolicyPack[] {
  const from = cleanPath(stackDir);
  const rel = (p: string): string => {
    const r = posix.relative(from === "." ? "" : from, p);
    // A path the engine reads as a flag never reaches it; ./ keeps it a path.
    return r === "" ? "." : r.startsWith("-") ? `./${r}` : r;
  };
  return packs.map((p) => ({ dir: rel(p.dir), ...(p.config ? { config: rel(p.config) } : {}) }));
}

/** chant's `ci.policy` for plywood.yml's Rego keys, or undefined when it sets none. */
export function chantPolicyOf(doc: RawConfig): ChantPolicySettings | undefined {
  const p = doc.policy;
  if (!isObject(p)) return undefined;
  const rego = typeof p.rego === "string" ? cleanPath(p.rego) : undefined;
  const command = Array.isArray(p.command) ? (p.command as string[]) : undefined;
  if (rego === undefined && command === undefined && p.engine === undefined && p.namespace === undefined) return undefined;
  return {
    ...(typeof p.engine === "string" ? { engine: p.engine as PolicyEngine } : {}),
    ...(rego !== undefined ? { path: rego } : {}),
    ...(typeof p.namespace === "string" ? { namespace: p.namespace } : {}),
    ...(command ? { command } : {}),
  };
}

export const policy: ConfigGroup = {
  name: "policy",
  keys: ["policy"],
  schema: {
    policy: {
      type: "object",
      additionalProperties: false,
      description: "Rego rules and CrossGuard policy packs in the preview job, feeding chant's gate. Read at base.",
      properties: {
        rego: { type: "string", description: "The directory of Rego rules, relative to the repository root. deny_* denies, hold_* waits for a person, warn_* is a note line." },
        engine: { type: "string", enum: [...POLICY_ENGINES], default: "conftest", description: "The result shape the rules' engine prints: conftest or opa. A hold needs opa." },
        namespace: { type: "string", description: "The Rego package to read. conftest: every package; opa: main." },
        command: { type: "array", items: { type: "string" }, minItems: 1, description: "argv in place of the engine's own; {policy} is the rules' directory at base, {input} the change set." },
        packs: {
          type: "array",
          description: "CrossGuard packs the preview and the update run with --policy-pack. Mandatory violations deny; advisory ones are note lines.",
          items: {
            oneOf: [
              { type: "string", description: "The pack's directory, relative to the repository root." },
              {
                type: "object",
                additionalProperties: false,
                required: ["dir"],
                properties: {
                  dir: { type: "string", description: "The pack's directory, relative to the repository root." },
                  config: { type: "string", description: "Its --policy-pack-config file." },
                },
              },
            ],
          },
        },
      },
    },
  },
  check(doc) {
    const p = doc.policy;
    if (p === undefined) return [];
    if (!isObject(p)) return [error("policy", "must be a mapping of rego and packs")];
    const out: ConfigProblem[] = [];
    for (const k of Object.keys(p)) if (k in NO_SUCH_KEY) out.push(error(`policy.${k}`, `is not a plywood key: ${NO_SUCH_KEY[k]}`));
    out.push(...onlyKeys(Object.fromEntries(Object.entries(p).filter(([k]) => !(k in NO_SUCH_KEY))), POLICY_KEYS, "policy"));
    if (p.rego !== undefined) out.push(...repoPath(p.rego, "policy.rego"));
    out.push(...oneOf(p.engine, POLICY_ENGINES, "policy.engine"));
    if (p.namespace !== undefined && (typeof p.namespace !== "string" || p.namespace.trim() === "")) out.push(error("policy.namespace", "is a Rego package name"));
    if (p.command !== undefined) {
      if (!Array.isArray(p.command) || p.command.length === 0 || p.command.some((a) => typeof a !== "string" || a === "")) out.push(error("policy.command", "is argv, a list of strings"));
      else if (!p.command.some((a: string) => a.includes("{input}"))) out.push(error("policy.command", "must pass the change set as {input}"));
    }
    if (p.packs !== undefined) {
      if (!Array.isArray(p.packs)) out.push(error("policy.packs", "is a list of pack directories"));
      else {
        p.packs.forEach((pack, i) => {
          const key = `policy.packs.${i}`;
          if (typeof pack === "string") out.push(...repoPath(pack, key));
          else if (isObject(pack)) {
            out.push(...onlyKeys(pack, PACK_KEYS, key), ...repoPath(pack.dir, `${key}.dir`));
            if (pack.config !== undefined) out.push(...repoPath(pack.config, `${key}.config`));
          } else out.push(error(key, "is a pack directory, or { dir, config }"));
        });
        const dirs = policyPacksOf(doc).map((x) => x.dir);
        const twice = dirs.filter((d, i) => dirs.indexOf(d) !== i);
        if (twice.length) out.push(error("policy.packs", `lists ${[...new Set(twice)].join(", ")} more than once`));
      }
    }
    return out;
  },
  translate(doc, out) {
    const rego = chantPolicyOf(doc);
    if (rego) out.ci.policy = rego;
    const packs = policyPacksOf(doc);
    if (packs.length) out.pipeline.policyPacks = packs;
  },
};
