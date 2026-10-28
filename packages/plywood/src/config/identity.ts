/**
 * `identity` and `pulumi_cloud`: who the preview job and the update job are,
 * per cloud and stack glob, rendered as chant's `ci.identity.cloud`
 * (chant#4296, #4332, and #4549 for Pulumi Cloud).
 *
 *   identity.preview          cloud to identity, for every stack
 *   identity.up               cloud to identity, for every stack
 *   identity.stacks           stack glob to { preview, up, environments },
 *                             each a cloud-to-identity map, over the two above
 *   identity.aws              region, audience, endpoint
 *   identity.gcp              provider, audience, sts_endpoint, iam_endpoint
 *   identity.azure            tenant_id, subscription_id, audience, authority
 *   pulumi_cloud.org          ci.identity.cloud.pulumi.organization
 *   pulumi_cloud.api_url      its apiUrl: a self-hosted Pulumi Cloud, or a
 *                             loopback fake in tests (default https://api.pulumi.com)
 *   pulumi_cloud.audience     its audience (default urn:pulumi:org:<org>)
 *
 * The clouds are aws (a role ARN), gcp (a service account), azure (a client
 * id) and pulumi (a Pulumi Cloud token: team:<name>, user:<login>,
 * organization or organization:admin). Each cloud's rules are the stack
 * globs in plywood.yml's order, then the every-stack pair; chant takes the
 * first that matches, with preview as the rule's plan identity and up as
 * its apply identity.
 *
 * The preview job trades its forge OIDC token before the program is checked
 * out, and every later step starts without the token request variables, so
 * a pull request's program never holds a forge token or the up identity.
 * On Pulumi Cloud the trade gives the preview job one access token and the
 * update job another (chant#4549); stock Pulumi opens a stack's ESC
 * environments with that token (ruling H). plywood passes the token and
 * nothing else. One identity for both stages is refused.
 *
 * A stack glob is chant's target glob over `project/stack`: `*` stays within
 * one segment, so `shop/*` is every shop stack and `**` every stack.
 */
import { error, isObject, onlyKeys, warning, type ConfigGroup, type ConfigProblem, type JsonSchema, type RawConfig } from "./types";

export const IDENTITY_CLOUDS = ["aws", "gcp", "azure", "pulumi"] as const;
export type IdentityCloud = (typeof IDENTITY_CLOUDS)[number];
export const STAGES = ["preview", "up"] as const;
export type Stage = (typeof STAGES)[number];

/** Each cloud's own settings under identity.<cloud>: plywood's snake_case key to chant's. Pulumi Cloud's are under pulumi_cloud. */
export const CLOUD_SETTINGS = {
  aws: { region: "region", audience: "audience", endpoint: "endpoint" },
  gcp: { provider: "provider", audience: "audience", sts_endpoint: "stsEndpoint", iam_endpoint: "iamEndpoint" },
  azure: { tenant_id: "tenantId", subscription_id: "subscriptionId", audience: "audience", authority: "authority" },
} as const satisfies Record<Exclude<IdentityCloud, "pulumi">, Record<string, string>>;
type SettingsCloud = keyof typeof CLOUD_SETTINGS;
const SETTINGS_CLOUDS = Object.keys(CLOUD_SETTINGS) as SettingsCloud[];

/** Settings a cloud cannot trade without. */
const REQUIRED: Readonly<Record<IdentityCloud, readonly string[]>> = { aws: [], gcp: ["identity.gcp.provider"], azure: ["identity.azure.tenant_id"], pulumi: ["pulumi_cloud.org"] };

export const IDENTITY_KEYS = ["preview", "up", "stacks", ...SETTINGS_CLOUDS] as const;
export const STACK_RULE_KEYS = ["preview", "up", "environments"] as const;
export const PULUMI_CLOUD_KEYS = ["org", "api_url", "audience"] as const;

/** A glob that covers every stack, written as no target glob in chant's rule. */
const EVERY_STACK = new Set(["*", "**"]);

/** One rule for one cloud, as plywood.yml names it. `glob` is undefined for the every-stack pair. */
export interface StageIdentityRule {
  glob?: string;
  preview: string;
  up: string;
  environments?: string[];
}

/** One rule of chant's `ci.identity.cloud.<cloud>.rules` (`CloudIdentityRule`). */
export interface ChantIdentityRule {
  environments?: string[];
  targets?: string[];
  plan: string;
  apply: string;
}

/** chant's `ci.identity` as plywood writes it. */
export interface ChantIdentitySettings {
  cloud: Partial<Record<IdentityCloud, Record<string, unknown> & { rules: ChantIdentityRule[] }>>;
}

const PULUMI_TOKEN = /^(?:(?:team|user):[^\s:]+|organization|organization:admin)$/;

/** Why `v` is no Pulumi Cloud token chant can trade for, or undefined. */
export function pulumiTokenProblem(v: string): string | undefined {
  return PULUMI_TOKEN.test(v) ? undefined : `is ${JSON.stringify(v)}; a Pulumi Cloud token is team:<name>, user:<login>, organization or organization:admin`;
}

const stageMap = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});

/** The rules plywood.yml gives `cloud`: the stack globs in order, then the every-stack pair. */
export function identityRules(doc: RawConfig, cloud: IdentityCloud): StageIdentityRule[] {
  const block = isObject(doc.identity) ? doc.identity : {};
  const out: StageIdentityRule[] = [];
  for (const [glob, r] of Object.entries(stageMap(block.stacks))) {
    if (!isObject(r)) continue;
    const preview = stageMap(r.preview)[cloud];
    const up = stageMap(r.up)[cloud];
    if (typeof preview !== "string" || typeof up !== "string") continue;
    out.push({ glob, preview, up, ...(Array.isArray(r.environments) ? { environments: r.environments as string[] } : {}) });
  }
  const preview = stageMap(block.preview)[cloud];
  const up = stageMap(block.up)[cloud];
  if (typeof preview === "string" && typeof up === "string") out.push({ preview, up });
  return out;
}

/** The clouds plywood.yml names identities for. */
export function identityClouds(doc: RawConfig): IdentityCloud[] {
  return IDENTITY_CLOUDS.filter((c) => identityRules(doc, c).length > 0);
}

/** One plywood rule as chant's. */
export function chantRule(r: StageIdentityRule): ChantIdentityRule {
  return {
    ...(r.environments?.length ? { environments: [...r.environments] } : {}),
    ...(r.glob === undefined || EVERY_STACK.has(r.glob) ? {} : { targets: [r.glob] }),
    plan: r.preview,
    apply: r.up,
  };
}

/** `pulumi_cloud` as read: the organization, and where its API is. */
export function pulumiCloudOf(doc: RawConfig): { org?: string; apiUrl?: string; audience?: string } {
  const p = isObject(doc.pulumi_cloud) ? doc.pulumi_cloud : {};
  return {
    ...(typeof p.org === "string" ? { org: p.org } : {}),
    ...(typeof p.api_url === "string" ? { apiUrl: p.api_url.replace(/\/+$/, "") } : {}),
    ...(typeof p.audience === "string" ? { audience: p.audience } : {}),
  };
}

/** chant's `ci.identity` for plywood.yml, or undefined when it names no identity. */
export function chantIdentityOf(doc: RawConfig): ChantIdentitySettings | undefined {
  const clouds = identityClouds(doc);
  if (clouds.length === 0) return undefined;
  const block = isObject(doc.identity) ? doc.identity : {};
  const cloud: ChantIdentitySettings["cloud"] = {};
  for (const c of clouds) {
    const settings: Record<string, unknown> = {};
    if (c === "pulumi") {
      const p = pulumiCloudOf(doc);
      settings.organization = p.org;
      if (p.audience) settings.audience = p.audience;
      if (p.apiUrl) settings.apiUrl = p.apiUrl;
    } else {
      const own = stageMap(block[c]);
      for (const [plywood, chant] of Object.entries(CLOUD_SETTINGS[c])) if (own[plywood] !== undefined) settings[chant] = own[plywood];
    }
    cloud[c] = { ...settings, rules: identityRules(doc, c).map(chantRule) };
  }
  return { cloud };
}

/** The identity `stack` takes for each cloud and stage, first match wins as chant reads it. `match` is chant's target glob. */
export function stackIdentities(doc: RawConfig, stack: string, env: string, match: (glob: string, target: string) => boolean): Partial<Record<IdentityCloud, Record<Stage, string> & { rule: string }>> {
  const envMatch = (globs: string[] | undefined): boolean => !globs?.length || globs.some((g) => (g.startsWith("!") ? !match(g.slice(1), env) : match(g, env)));
  const out: Partial<Record<IdentityCloud, Record<Stage, string> & { rule: string }>> = {};
  for (const c of IDENTITY_CLOUDS) {
    const r = identityRules(doc, c).find((x) => envMatch(x.environments) && (x.glob === undefined || EVERY_STACK.has(x.glob) || match(x.glob, stack)));
    if (r) out[c] = { preview: r.preview, up: r.up, rule: r.glob === undefined ? "identity.preview and identity.up" : `identity.stacks.${r.glob}` };
  }
  return out;
}

const CLOUD_MAP: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    aws: { type: "string", description: "An IAM role ARN." },
    gcp: { type: "string", description: "A service account email." },
    azure: { type: "string", description: "An Entra app's client id." },
    pulumi: { type: "string", pattern: PULUMI_TOKEN.source, description: "A Pulumi Cloud token: team:<name>, user:<login>, organization or organization:admin." },
  },
};

function stageMapProblems(v: unknown, key: string): ConfigProblem[] {
  if (v === undefined) return [];
  if (!isObject(v)) return [error(key, `maps a cloud (${IDENTITY_CLOUDS.join(", ")}) to an identity`)];
  const out = [...onlyKeys(v, IDENTITY_CLOUDS, key)];
  for (const [c, id] of Object.entries(v)) {
    if (!(IDENTITY_CLOUDS as readonly string[]).includes(c)) continue;
    if (typeof id !== "string" || id === "") out.push(error(`${key}.${c}`, "names the identity"));
    else if (c === "pulumi") {
      const why = pulumiTokenProblem(id);
      if (why) out.push(error(`${key}.${c}`, why));
    }
  }
  return out;
}

/** A preview and up pair, `where` naming them: each cloud on both sides, and never one identity for both. */
function pairProblems(preview: unknown, up: unknown, where: string): ConfigProblem[] {
  const p = stageMap(preview);
  const u = stageMap(up);
  const out: ConfigProblem[] = [];
  for (const c of IDENTITY_CLOUDS) {
    if ((p[c] === undefined) !== (u[c] === undefined)) out.push(error(`${where}.${p[c] === undefined ? "preview" : "up"}.${c}`, `is missing: ${c} names a ${p[c] === undefined ? "preview" : "up"} identity beside the ${p[c] === undefined ? "up" : "preview"} one`));
    else if (typeof p[c] === "string" && p[c] === u[c]) out.push(error(where, `gives ${c} one identity for preview and up, so a pull request's program could update with it; give each stage its own`));
  }
  return out;
}

export const identity: ConfigGroup = {
  name: "identity",
  keys: ["identity", "pulumi_cloud"],
  schema: {
    identity: {
      type: "object",
      additionalProperties: false,
      description: "The preview and up identities per cloud, for every stack and per stack glob. The preview job trades its OIDC token before the program is checked out.",
      properties: {
        preview: { ...CLOUD_MAP, description: "The preview job's identity per cloud, for every stack." },
        up: { ...CLOUD_MAP, description: "The update job's identity per cloud, for every stack." },
        stacks: {
          type: "object",
          description: "Stack glob (project/stack; * stays within one segment) to its own preview and up identities. The first glob that matches a stack is its.",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              preview: CLOUD_MAP,
              up: CLOUD_MAP,
              environments: { type: "array", items: { type: "string" }, description: "Environment globs the rule covers. Absent: every environment." },
            },
          },
        },
        ...Object.fromEntries(SETTINGS_CLOUDS.map((c) => [c, { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.keys(CLOUD_SETTINGS[c]).map((k) => [k, { type: "string" }])) }])),
      },
    },
    pulumi_cloud: {
      type: "object",
      additionalProperties: false,
      required: ["org"],
      description: "The Pulumi Cloud organization the stacks' state is in. With identity's pulumi tokens, each job trades for its own access token.",
      properties: {
        org: { type: "string", description: "The organization." },
        api_url: { type: "string", description: "The Pulumi Cloud API, for a self-hosted one. Default https://api.pulumi.com." },
        audience: { type: "string", description: "The OIDC token's audience. Default urn:pulumi:org:<org>." },
      },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    const p = doc.pulumi_cloud;
    if (p !== undefined) {
      if (!isObject(p)) out.push(error("pulumi_cloud", "must be a mapping with org"));
      else {
        out.push(...onlyKeys(p, PULUMI_CLOUD_KEYS, "pulumi_cloud"));
        if (typeof p.org !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.org)) out.push(error("pulumi_cloud.org", "names the Pulumi Cloud organization"));
        if (p.api_url !== undefined && (typeof p.api_url !== "string" || !/^https?:\/\/\S+$/.test(p.api_url))) out.push(error("pulumi_cloud.api_url", "must be an http or https URL"));
        if (p.audience !== undefined && (typeof p.audience !== "string" || p.audience === "")) out.push(error("pulumi_cloud.audience", "must be a string"));
      }
    }
    const block = doc.identity;
    if (block === undefined) {
      if (isObject(p)) out.push(warning("pulumi_cloud", "has no pulumi identities, so the jobs need long-lived tokens in the forge's secrets; set identity.preview.pulumi and identity.up.pulumi and each job trades its OIDC token for its own"));
      return out;
    }
    if (!isObject(block)) return [...out, error("identity", "must be a mapping of preview, up and stacks")];
    out.push(...onlyKeys(block, IDENTITY_KEYS, "identity"));
    out.push(...stageMapProblems(block.preview, "identity.preview"), ...stageMapProblems(block.up, "identity.up"), ...pairProblems(block.preview, block.up, "identity"));
    if (block.stacks !== undefined) {
      if (!isObject(block.stacks)) out.push(error("identity.stacks", "maps a stack glob to { preview, up }"));
      else {
        for (const [glob, r] of Object.entries(block.stacks)) {
          const key = `identity.stacks.${glob}`;
          if (!isObject(r)) {
            out.push(error(key, "must be { preview, up }"));
            continue;
          }
          out.push(...onlyKeys(r, STACK_RULE_KEYS, key), ...stageMapProblems(r.preview, `${key}.preview`), ...stageMapProblems(r.up, `${key}.up`), ...pairProblems(r.preview, r.up, key));
          if (r.environments !== undefined && (!Array.isArray(r.environments) || r.environments.some((e) => typeof e !== "string"))) out.push(error(`${key}.environments`, "must be a list of environment globs"));
        }
      }
    }
    for (const c of SETTINGS_CLOUDS) {
      const s = block[c];
      if (s === undefined) continue;
      if (!isObject(s)) {
        out.push(error(`identity.${c}`, `must be a mapping of ${Object.keys(CLOUD_SETTINGS[c]).join(", ")}`));
        continue;
      }
      out.push(...onlyKeys(s, Object.keys(CLOUD_SETTINGS[c]), `identity.${c}`));
      for (const [k, v] of Object.entries(s)) if (typeof v !== "string" || v === "") out.push(error(`identity.${c}.${k}`, "must be a string"));
    }
    for (const c of identityClouds(doc)) {
      for (const req of REQUIRED[c]) {
        const [top, ...path] = req.split(".");
        let v: unknown = doc[top!];
        for (const seg of path) v = isObject(v) ? v[seg] : undefined;
        if (v === undefined) out.push(error(req, `is required: identity names ${c} identities`));
      }
    }
    return out;
  },
  translate(doc, out) {
    const id = chantIdentityOf(doc);
    if (id) out.ci.identity = id;
  },
};
