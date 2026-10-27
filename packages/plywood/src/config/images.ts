/**
 * `pulumi`, `plunge`, `image` and `runners`: the engine release each stack
 * runs, the image every job runs in, and the runners the jobs land on
 * (plywood#12).
 *
 *   pulumi   a version, or stack glob to version     member engineVersion, pipeline engineSetup
 *   plunge   the same, for plunge stacks              member engineVersion, pipeline engineSetup
 *   image    a reference, or { name, plugins }        pipeline image
 *   runners  a label, labels, a GitHub group, or     pipeline runner
 *            default/preview/up/drift to one of those
 *
 * Each stack's engine comes from the engine group, which runs first; a stack
 * with none set installs Pulumi, the engine chant picks without a plunge
 * backend. The version most stacks of an engine run is linked onto PATH; a
 * stack pinned to another gets its binary's path as `engineBin`. The
 * install lines are src/images.ts's and check the release checksums.
 */
import { DIGEST, imageFor, imageReference, installLines, engineBin, parsePlugin, PLUGIN, TOOL_VERSIONS, type EngineName, type EnginePin } from "../images";
import type { ChantRunner } from "../chant-config";
import { error, isObject, onlyKeys, warning, type ConfigGroup, type ConfigProblem, type JsonSchema, type RawConfig } from "./types";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LABEL = /^[^\s,]+$/;
export const RUNNER_STAGES = ["default", "preview", "up", "drift"] as const;
export const IMAGE_KEYS = ["name", "plugins"] as const;

const versionSchema = (engine: string, example: string): JsonSchema => ({
  description: `The ${engine} release the jobs run, such as ${example}: one for every stack, or a map of stack glob to release. plywood's image's release when absent.`,
  anyOf: [
    { type: "string", pattern: VERSION.source },
    { type: "object", minProperties: 1, additionalProperties: { type: "string", pattern: VERSION.source } },
  ],
});

const runnerSpecSchema: JsonSchema = {
  anyOf: [
    { type: "string", pattern: LABEL.source },
    { type: "array", items: { type: "string", pattern: LABEL.source }, minItems: 1, uniqueItems: true },
    {
      type: "object",
      additionalProperties: false,
      required: ["group"],
      properties: { group: { type: "string", minLength: 1 }, labels: { type: "array", items: { type: "string", pattern: LABEL.source }, minItems: 1, uniqueItems: true } },
    },
  ],
};

/** `*` matches any run of characters, `/` included. */
export function globMatches(glob: string, name: string): boolean {
  const re = new RegExp(`^${glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

/** The release `pin` gives `stack`, or undefined when a map names no glob that matches it. */
export function pinFor(pin: unknown, stack: string | undefined): string | undefined {
  if (typeof pin === "string") return pin;
  if (!isObject(pin)) return undefined;
  if (stack !== undefined) {
    if (typeof pin[stack] === "string") return pin[stack] as string;
    for (const [glob, v] of Object.entries(pin)) if (typeof v === "string" && globMatches(glob, stack)) return v;
  }
  return typeof pin["*"] === "string" ? (pin["*"] as string) : undefined;
}

function versionProblems(v: unknown, key: string): ConfigProblem[] {
  if (v === undefined) return [];
  if (typeof v === "string") return VERSION.test(v) ? [] : [error(key, `is ${JSON.stringify(v)}; give a release such as ${key === "plunge" ? TOOL_VERSIONS.plunge : TOOL_VERSIONS.pulumi}`)];
  if (!isObject(v) || Object.keys(v).length === 0) return [error(key, "must be a release, or a map of stack glob to release")];
  return Object.entries(v)
    .filter(([, r]) => typeof r !== "string" || !VERSION.test(r))
    .map(([g]) => error(`${key}.${g}`, "must be a release such as 1.2.3"));
}

function runnerSpecProblems(v: unknown, key: string, forge: unknown): ConfigProblem[] {
  const label = (x: unknown): boolean => typeof x === "string" && LABEL.test(x);
  const labels = (x: unknown): boolean => Array.isArray(x) && x.length > 0 && x.every(label) && new Set(x).size === x.length;
  if (typeof v === "string") return label(v) ? [] : [error(key, "must be a runner label, such as self-hosted, with no spaces or commas")];
  if (Array.isArray(v)) return labels(v) ? [] : [error(key, "must be a list of distinct runner labels, such as [self-hosted, linux]")];
  if (!isObject(v) || !("group" in v)) return [error(key, "must be a runner label, a list of labels, or a map with group")];
  const out = onlyKeys(v, ["group", "labels"], key);
  if (typeof v.group !== "string" || v.group.trim() === "") out.push(error(`${key}.group`, "must name a GitHub runner group"));
  if (v.labels !== undefined && !labels(v.labels)) out.push(error(`${key}.labels`, "must be a list of distinct runner labels"));
  if (forge !== undefined && forge !== "github") out.push(error(`${key}.group`, `runner groups are GitHub's; on ${String(forge)} give a label or a list of labels`));
  return out;
}

/** Whether `runners` maps stages to runners, rather than naming one runner. */
function byStage(v: unknown): v is Record<string, unknown> {
  return isObject(v) && !("group" in v);
}

function runnersProblems(v: unknown, forge: unknown): ConfigProblem[] {
  if (v === undefined) return [];
  if (!byStage(v)) return runnerSpecProblems(v, "runners", forge);
  if (Object.keys(v).length === 0) return [error("runners", `must name a runner, or map ${RUNNER_STAGES.join(", ")} to one`)];
  return Object.entries(v).flatMap(([k, spec]) =>
    (RUNNER_STAGES as readonly string[]).includes(k) ? runnerSpecProblems(spec, `runners.${k}`, forge) : [error(`runners.${k}`, `is not a stage; the stages are ${RUNNER_STAGES.join(", ")}`)],
  );
}

function imageProblems(v: unknown): ConfigProblem[] {
  if (v === undefined) return [];
  const unpinned = (name: string): ConfigProblem[] =>
    DIGEST.test(name) ? [] : [warning("image", `${name} is not pinned by digest, so a push to its tag changes what the jobs run; name it as <image>@sha256:<digest>`)];
  if (typeof v === "string") return v.trim() === "" ? [error("image", "must be an image reference")] : unpinned(v);
  if (!isObject(v)) return [error("image", `must be an image reference, or a map of ${IMAGE_KEYS.join(", ")}`)];
  const out = onlyKeys(v, IMAGE_KEYS, "image");
  if (v.name !== undefined && (typeof v.name !== "string" || v.name.trim() === "")) out.push(error("image.name", "must be an image reference"));
  else if (typeof v.name === "string") out.push(...unpinned(v.name));
  if (v.plugins !== undefined) {
    if (!Array.isArray(v.plugins)) out.push(error("image.plugins", "must be a list of plugins such as aws@7.4.0"));
    else v.plugins.forEach((p, i) => {
      if (typeof p !== "string" || !parsePlugin(p)) out.push(error(`image.plugins[${i}]`, `is ${JSON.stringify(p)}; give name@version, or kind:name@version`));
    });
    if (v.name === undefined) out.push(warning("image.plugins", "lists plugins with no image.name, so the jobs keep plywood's image; build the prepared image and name it in image.name"));
  }
  return out;
}

/** The image reference `image` names, in either form. */
export function userImage(doc: RawConfig): string | undefined {
  if (typeof doc.image === "string") return doc.image;
  return isObject(doc.image) && typeof doc.image.name === "string" ? doc.image.name : undefined;
}

/** The plugins `image.plugins` lists, parsed. */
export function imagePlugins(doc: RawConfig) {
  const list = isObject(doc.image) && Array.isArray(doc.image.plugins) ? (doc.image.plugins as unknown[]) : [];
  return list.flatMap((p) => (typeof p === "string" && parsePlugin(p) ? [parsePlugin(p)!] : []));
}

/** The release of `engine` most of `stacks` run: the linked one. Ties go to the top-level pin, then plywood's. */
function linkedVersion(engine: EngineName, doc: RawConfig, versions: string[]): string {
  const top = pinFor(doc[engine], undefined) ?? TOOL_VERSIONS[engine];
  if (versions.length === 0) return top;
  const count = new Map<string, number>();
  for (const v of versions) count.set(v, (count.get(v) ?? 0) + 1);
  const best = Math.max(...count.values());
  return count.get(top) === best ? top : [...count].find(([, n]) => n === best)![0];
}

export const images: ConfigGroup = {
  name: "images",
  keys: ["pulumi", "plunge", "image", "runners"],
  schema: {
    pulumi: versionSchema("Pulumi CLI", TOOL_VERSIONS.pulumi),
    plunge: versionSchema("plunge", TOOL_VERSIONS.plunge),
    image: {
      description: "The image every job runs in, in place of plywood's: a reference pinned by digest, or a map with name and the plugins a prepared image carries.",
      anyOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", description: "The image reference, built FROM plywood-pulumi or plywood-plunge, pinned by digest." },
            plugins: { type: "array", items: { type: "string", pattern: PLUGIN.source }, description: "Plugins the prepared image installs, as name@version or kind:name@version." },
          },
        },
      ],
    },
    runners: {
      description: "The runner every job runs on: a label, a list of labels, or a GitHub runner group; or default, preview, up and drift each mapped to one. runs-on on GitHub and Forgejo, tags on GitLab.",
      anyOf: [runnerSpecSchema, { type: "object", minProperties: 1, not: { required: ["group"] }, propertyNames: { enum: [...RUNNER_STAGES] }, additionalProperties: runnerSpecSchema }],
    },
  },
  check(doc) {
    const forge = isObject(doc.forge) ? doc.forge.kind : undefined;
    const out: ConfigProblem[] = [...versionProblems(doc.pulumi, "pulumi"), ...versionProblems(doc.plunge, "plunge"), ...imageProblems(doc.image), ...runnersProblems(doc.runners, forge)];
    const listed = isObject(doc.stacks) ? Object.keys(doc.stacks) : [];
    for (const key of ["pulumi", "plunge"] as const) {
      const pin = doc[key];
      if (!isObject(pin) || listed.length === 0) continue;
      for (const glob of Object.keys(pin)) {
        if (glob !== "*" && !listed.some((s) => globMatches(glob, s))) out.push(warning(`${key}.${glob}`, "matches no stack under stacks"));
      }
    }
    return out;
  },
  translate(doc, out) {
    const engineOfMember = (e: EngineName | undefined): EngineName => e ?? out.memberDefaults.engine ?? "pulumi";
    const per: Record<EngineName, string[]> = { pulumi: [], plunge: [] };
    const chosen = out.members.map((m) => {
      const engine = engineOfMember(m.engine);
      const version = pinFor(doc[engine], m.name) ?? pinFor(doc[engine], undefined) ?? TOOL_VERSIONS[engine];
      per[engine].push(version);
      return { m, engine, version };
    });
    const engines = new Set<EngineName>(chosen.map((c) => c.engine));
    engines.add(engineOfMember(undefined));
    if (doc.plunge !== undefined) engines.add("plunge");
    const linked = Object.fromEntries([...engines].map((e) => [e, linkedVersion(e, doc, per[e])])) as Partial<Record<EngineName, string>>;

    const pins: EnginePin[] = [...engines].map((engine) => ({ engine, version: linked[engine]!, linked: true }));
    for (const { m, engine, version } of chosen) {
      if (doc[engine] !== undefined) m.engineVersion = version;
      if (version !== linked[engine]) {
        m.engineBin = engineBin(engine, version);
        pins.push({ engine, version, linked: false });
      }
    }
    out.pipeline.engineSetup = installLines(pins);

    const own = userImage(doc);
    if (own) out.pipeline.image = own;
    else {
      // plunge's image when every stack runs plunge, else Pulumi's; by digest only, so an unpublished image is never named.
      const ref = imageFor(engines.size === 1 && engines.has("plunge") ? "plunge" : "pulumi");
      if (ref.digest) out.pipeline.image = imageReference(ref);
    }
    if (doc.runners !== undefined) out.pipeline.runner = structuredClone(doc.runners) as ChantRunner;
  },
};

