/**
 * `policy`: Rego rules over the change set and CrossGuard policy packs, both
 * in the preview job and both feeding chant's gate (plywood#13, ruling 7).
 *
 *   policy.rego       ci.policy.path   a directory of Rego rules, read at base
 *   policy.engine     ci.policy.engine conftest (default) or opa, the result shape
 *   policy.namespace  ci.policy.namespace
 *   policy.command    ci.policy.command argv in place of the engine's own
 *   policy.packs      each stack's pulumi-up step `policyPacks` (chant#4541):
 *                     the preview and the update run `--policy-pack <dir>`;
 *                     on a chant with chant#4613 also ci.policy.packs, read
 *                     at base, so a pull request cannot drop or edit a pack
 *   policy.source     ci.policy.source { repo, ref, path } (chant#4613): a
 *                     shared rule set from a git ref, fetched by the job at
 *                     the ref the base names. `path` is the Rego directory
 *                     inside it; `packs` are then paths inside it too.
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
 *
 * `source` and `ci.policy.packs` need chant's policy source
 * (`@intentius/chant/policy-source`, `CI_POLICY_SOURCE_FLOOR`). The config
 * translation is synchronous, so the CLI awaits {@link useChantPolicySource}
 * once before a command. On a chant without it (the 0.124.54 pin) `source`
 * is refused as before and packs ride in the step input alone.
 */
import { posix } from "node:path";
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

/** chant's result shapes (`GATE_POLICY_ENGINES`, @intentius/chant/gate-policy). */
export const POLICY_ENGINES = ["conftest", "opa"] as const;
export type PolicyEngine = (typeof POLICY_ENGINES)[number];

export const POLICY_KEYS = ["rego", "engine", "namespace", "command", "packs", "source", "providers"] as const;
export const PACK_KEYS = ["dir", "config"] as const;
export const SOURCE_KEYS = ["repo", "ref", "path"] as const;

/** chant's accepted repository forms for `ci.policy.source.repo` (policy-source.ts). */
const SOURCE_REPO = /^(https?:\/\/[^\s/]+\/\S+|ssh:\/\/[^\s/]+\/\S+|file:\/\/\/?\S+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+)$/;
const SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

let policySource = false;
let policySourceLoading: Promise<boolean> | undefined;

/** True when the installed chant reads `ci.policy.source` and `ci.policy.packs` (chant#4613). */
export function useChantPolicySource(): Promise<boolean> {
  policySourceLoading ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.54 (chant#4613).
      const m: Record<string, unknown> = await import("@intentius/chant/policy-source");
      policySource = typeof m.CI_POLICY_SOURCE_FLOOR === "string" && typeof m.assertGatePolicySource === "function";
    } catch {
      policySource = false;
    }
    return policySource;
  })();
  return policySourceLoading;
}

/** Whether {@link useChantPolicySource} found chant's policy source. */
export function chantHasPolicySource(): boolean {
  return policySource;
}

/** Tests say whether chant has the policy source. `reset` forgets it and the import. */
export function setChantPolicySourceForTests(has: boolean | "reset"): void {
  policySource = has === true;
  policySourceLoading = has === "reset" ? undefined : Promise.resolve(has === true);
}

/** Keys a reader of terragucci's `policy` or Pulumi Deployments may reach for, and why plywood has none. */
const NO_SUCH_KEY: Readonly<Record<string, string>> = {
  allow_unattended: "chant's gate denies and holds only; a non-empty change always waits for a person, so there is no unattended outcome",
  outcomes: "a Rego rule's name sets its outcome: deny_* denies, hold_* holds, warn_* is a note line",
};

/** Why `policy.source` is refused on a chant without chant#4613. */
const SOURCE_NEEDS_CHANT =
  "is a shared policy source from a git ref, which needs chant >= the release after 0.124.54 (chant#4613's ci.policy.source); on this chant, vendor the rules into the repository, where they are read at base";

/** chant's `ci.policy.source` (`GatePolicySource`, chant#4613). */
export interface ChantPolicySource {
  repo: string;
  ref: string;
  path?: string;
}

/** chant's `ci.policy` (`GatePolicySettings`). */
export interface ChantPolicySettings {
  engine?: PolicyEngine;
  path?: string;
  namespace?: string;
  command?: string[];
  /** The shared source, read at the ref the base names (chant#4613). */
  source?: ChantPolicySource;
  /** CrossGuard packs every preview runs, read at base or from `source` (chant#4613). */
  packs?: PolicyPack[];
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

/** plywood.yml's `policy.providers`: the provider packages the preset allows, or undefined when it sets none. */
export function policyProvidersOf(doc: RawConfig): string[] | undefined {
  const list = isObject(doc.policy) ? doc.policy.providers : undefined;
  return Array.isArray(list) && list.length > 0 ? list.filter((s): s is string => typeof s === "string") : undefined;
}

/** plywood.yml's `policy.source` as chant's, or undefined. */
export function policySourceOf(doc: RawConfig): ChantPolicySource | undefined {
  const src = isObject(doc.policy) ? doc.policy.source : undefined;
  if (!isObject(src) || typeof src.repo !== "string" || typeof src.ref !== "string") return undefined;
  return { repo: src.repo, ref: src.ref, ...(typeof src.path === "string" ? { path: cleanPath(src.path) } : {}) };
}

/**
 * chant's `ci.policy` for plywood.yml's policy keys, or undefined when it
 * sets none. `chantReadsSource` (default: what {@link useChantPolicySource}
 * found) adds `source` and lists the packs in `packs`; without it the packs
 * ride in each step's input alone.
 */
export function chantPolicyOf(doc: RawConfig, chantReadsSource = chantHasPolicySource()): ChantPolicySettings | undefined {
  const p = doc.policy;
  if (!isObject(p)) return undefined;
  const rego = typeof p.rego === "string" ? cleanPath(p.rego) : undefined;
  const command = Array.isArray(p.command) ? (p.command as string[]) : undefined;
  const source = chantReadsSource ? policySourceOf(doc) : undefined;
  const packs = chantReadsSource ? policyPacksOf(doc) : [];
  if (rego === undefined && command === undefined && p.engine === undefined && p.namespace === undefined && !source && packs.length === 0) return undefined;
  return {
    ...(typeof p.engine === "string" ? { engine: p.engine as PolicyEngine } : {}),
    ...(rego !== undefined ? { path: rego } : {}),
    ...(typeof p.namespace === "string" ? { namespace: p.namespace } : {}),
    ...(command ? { command } : {}),
    ...(source ? { source } : {}),
    ...(packs.length ? { packs } : {}),
  };
}

/**
 * The packs each stack's step input carries. With a shared source the packs
 * are paths inside that repository, which chant reads from `ci.policy.packs`
 * alone; otherwise the step carries them too (chant reads a pack listed in
 * both once, from base).
 */
export function stepPolicyPacksOf(doc: RawConfig, chantReadsSource = chantHasPolicySource()): PolicyPack[] {
  return chantReadsSource && policySourceOf(doc) ? [] : policyPacksOf(doc);
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
        source: {
          type: "object",
          additionalProperties: false,
          required: ["repo", "ref"],
          description: "A shared rule set from a git ref, fetched by the job at the ref the base names (chant >= the release after 0.124.54). packs are then paths inside it.",
          properties: {
            repo: { type: "string", description: "The repository: https://, ssh:// or file:// URL, or git@<host>:<path>." },
            ref: { type: "string", description: "A tag, a branch or a full commit." },
            path: { type: "string", default: "policy", description: "The Rego directory inside the repository." },
          },
        },
        providers: {
          type: "array",
          items: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          uniqueItems: true,
          description: "The provider packages a stack may use, such as aws and random; component packages too. plywood init writes the allowlist as a Rego rule into policy.rego and as the CrossGuard pack policy/plywood-providers.",
        },
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
    if (p.source !== undefined) {
      if (!chantHasPolicySource()) out.push(error("policy.source", SOURCE_NEEDS_CHANT));
      else if (!isObject(p.source)) out.push(error("policy.source", "is { repo, ref, path }"));
      else {
        const src = p.source;
        out.push(...onlyKeys(src, SOURCE_KEYS, "policy.source"));
        if (typeof src.repo !== "string" || !SOURCE_REPO.test(src.repo) || src.repo.startsWith("-")) out.push(error("policy.source.repo", "is a git URL: https://, ssh://, file:// or git@<host>:<path>"));
        if (typeof src.ref !== "string" || !SOURCE_REF.test(src.ref) || src.ref.includes("..") || src.ref.endsWith("/")) out.push(error("policy.source.ref", "is a tag, a branch or a commit"));
        if (src.path !== undefined) out.push(...repoPath(src.path, "policy.source.path"));
        // chant takes the Rego directory from the source's path, so a workspace directory beside it would be read nowhere.
        if (p.rego !== undefined) out.push(error("policy.rego", "goes with no policy.source: with a source, policy.source.path names the Rego directory inside it"));
      }
    }
    out.push(...onlyKeys(Object.fromEntries(Object.entries(p).filter(([k]) => !(k in NO_SUCH_KEY))), POLICY_KEYS, "policy"));
    if (p.rego !== undefined) out.push(...repoPath(p.rego, "policy.rego"));
    out.push(...oneOf(p.engine, POLICY_ENGINES, "policy.engine"));
    if (p.namespace !== undefined && (typeof p.namespace !== "string" || p.namespace.trim() === "")) out.push(error("policy.namespace", "is a Rego package name"));
    if (p.command !== undefined) {
      if (!Array.isArray(p.command) || p.command.length === 0 || p.command.some((a) => typeof a !== "string" || a === "")) out.push(error("policy.command", "is argv, a list of strings"));
      else if (!p.command.some((a: string) => a.includes("{input}"))) out.push(error("policy.command", "must pass the change set as {input}"));
    }
    if (p.providers !== undefined) {
      if (!Array.isArray(p.providers) || p.providers.length === 0) out.push(error("policy.providers", "is a list of provider packages, such as [aws, random]"));
      else
        p.providers.forEach((name, i) => {
          if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) out.push(error(`policy.providers.${i}`, `is ${JSON.stringify(name)}; a provider package is a Pulumi type's first segment, such as aws`));
        });
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
    const packs = stepPolicyPacksOf(doc);
    if (packs.length) out.pipeline.policyPacks = packs;
  },
};
