/**
 * The provider allowlist preset (plywood#31): plywood.yml's
 * `policy.providers` lists the provider packages a stack may use, and
 * `plywood init` writes the same check twice, from `presets/policy/` in the
 * package (this module sits under `src/` so `../presets/` resolves from the
 * source and from the bundle):
 *
 *   <policy.rego>/plywood_providers.rego   a deny_provider_package rule
 *                                          over chant's change set, the
 *                                          list written into the rule
 *   policy/plywood-providers/              a CrossGuard pack, mandatory,
 *   policy/plywood-providers.json          its config: the list
 *
 * Both read a resource's provider package from its type: `aws` for
 * `aws:s3/bucket:Bucket`, the provided package for a provider resource
 * (`pulumi:providers:aws`), and none for the engine's own `pulumi:` types.
 * A component's package is its own namespace, so list it too. The Rego rule
 * judges what the change creates, updates or replaces; a delete or an
 * unchanged resource never denies. {@link providerDenials} is the same rule
 * in TypeScript, for the tests and for `plywood init` to say what the
 * preset would deny.
 */
import { readFileSync } from "node:fs";

/** A provider package name, as a Pulumi type's first segment spells it. */
export const PROVIDER_PACKAGE = /^[a-z][a-z0-9-]*$/;

/** Where `plywood init` writes the pack and its config, relative to the repository root. */
export const PROVIDERS_PACK_DIR = "policy/plywood-providers";
export const PROVIDERS_PACK_CONFIG = "policy/plywood-providers.json";
/** The Rego file's name inside policy.rego. */
export const PROVIDERS_REGO_FILE = "plywood_providers.rego";
/** The pack's policy name, which its config keys and its rule id (`crossguard.plywood-providers.provider-allowlist`) carry. */
export const PROVIDERS_POLICY = "provider-allowlist";

/** The provider package of a Pulumi type, or undefined for the engine's own types. */
export function providerPackageOf(type: string): string | undefined {
  if (type.startsWith("pulumi:providers:")) return type.slice("pulumi:providers:".length);
  if (type.startsWith("pulumi:") || type === "unknown") return undefined;
  return type.split(":")[0];
}

/** What the change set entries the rule reads hold. */
export interface PolicyEntry {
  lexicon: string;
  address: string;
  type: string;
  action: string;
}

const JUDGED = new Set(["create", "update", "replace"]);

/** The Rego rule's messages for `entries`, in order: one per created, updated or replaced resource whose package is not allowed. */
export function providerDenials(entries: readonly PolicyEntry[], allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  return entries.flatMap((e) => {
    if (e.lexicon !== "pulumi" || !JUDGED.has(e.action)) return [];
    const pkg = providerPackageOf(e.type);
    return pkg !== undefined && !ok.has(pkg) ? [`${e.address} uses the provider package ${pkg}, which policy.providers does not list`] : [];
  });
}

const preset = (rel: string): string => readFileSync(new URL(`../presets/policy/${rel}`, import.meta.url), "utf8");

/** The Rego rule with `allowed` written in, in `namespace` (default `main`, which conftest and opa read by default). */
export function providersRego(allowed: readonly string[], namespace = "main"): string {
  const set = allowed.length ? `{${[...new Set(allowed)].sort().map((p) => JSON.stringify(p)).join(", ")}}` : "set()";
  return preset("plywood_providers.rego.tmpl").replace("{{namespace}}", namespace).replace("{{allowed}}", set);
}

/** The CrossGuard pack's files, relative to {@link PROVIDERS_PACK_DIR}. */
export function providersPackFiles(): Record<string, string> {
  return Object.fromEntries(["index.ts", "PulumiPolicy.yaml", "package.json"].map((f) => [f, preset(`plywood-providers/${f}`)]));
}

/** The pack's `--policy-pack-config` file: the list under the policy's name. */
export function providersPackConfig(allowed: readonly string[]): string {
  return JSON.stringify({ [PROVIDERS_POLICY]: { allowed: [...new Set(allowed)].sort() } }, null, 2) + "\n";
}
