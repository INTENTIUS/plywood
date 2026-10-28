// plywood's provider allowlist as a CrossGuard pack. 'plywood init' writes it
// with plywood-providers.json beside it, the list from plywood.yml's
// policy.providers; list the pack under policy.packs with that config to run
// it in every preview and update. A resource whose provider package is not
// listed is a mandatory violation, which denies at chant's gate.
import { PolicyPack } from "@pulumi/policy";

/** The provider package of a Pulumi type, or undefined for the engine's own types. */
function packageOf(type: string): string | undefined {
  if (type.startsWith("pulumi:providers:")) return type.slice("pulumi:providers:".length);
  if (type.startsWith("pulumi:") || type === "unknown") return undefined;
  return type.split(":")[0];
}

new PolicyPack("plywood-providers", {
  policies: [
    {
      name: "provider-allowlist",
      description: "Every resource comes from a provider package plywood.yml's policy.providers lists.",
      enforcementLevel: "mandatory",
      configSchema: { properties: { allowed: { type: "array", items: { type: "string" } } } },
      validateResource: (args, reportViolation) => {
        const allowed = args.getConfig<{ allowed?: string[] }>().allowed ?? [];
        const pkg = packageOf(args.type);
        if (pkg !== undefined && !allowed.includes(pkg)) reportViolation(`${args.urn} uses the provider package ${pkg}, which policy.providers does not list`);
      },
    },
  ],
});
