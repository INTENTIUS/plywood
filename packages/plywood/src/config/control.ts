/**
 * `control`: the control repo this repository answers to (plywood#18, on
 * chant#4568). After an update on merge, the workflow tells the control repo
 * which stack applied, and the control repo runs the repositories that
 * depend on it. The approvers and pins the control repo sets for each
 * repository are entries on its ledger (src/control.ts), never keys here.
 *
 *   control: github.com/acme/infra-control
 *
 * or the mapping, each key chant's `ControlSettingsInput` in snake_case:
 *
 *   control:
 *     repo: github.com/acme/infra-control   project key or https URL
 *     op: pulumi-up                         the Op run on the dependents
 *     member: shop                          this repo's name there
 *     forge: github                         when the host does not say
 *     token_secret: CHANT_CONTROL_TOKEN
 *     read_token_secret: CHANT_CONTROL_READ_TOKEN
 *     ref: main
 *     api_base: http://127.0.0.1:3000/api/v1
 *
 * The checks here are the shape; chant's `controlSettingsProblems` checks
 * the rest when `plywood ci` resolves the target.
 */
import type { ChantControlSettings } from "../chant-config";
import { OP_NAME } from "../words";
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

/** plywood.yml's `control` keys, to chant's `ControlSettingsInput` names. */
export const CONTROL_KEYS = {
  repo: "repo",
  op: "op",
  member: "member",
  forge: "forge",
  token_secret: "tokenSecret",
  read_token_secret: "readTokenSecret",
  ref: "ref",
  api_base: "apiBase",
} as const satisfies Record<string, keyof ChantControlSettings>;

const CONTROL_FORGES = ["github", "gitlab", "forgejo"] as const;

/** A repo as the project key chant takes: `https://github.com/acme/x.git` becomes `github.com/acme/x`. */
export function controlRepoKey(repo: string): string {
  return repo
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** `control` as chant's settings, or undefined when plywood.yml has none. */
export function controlOf(doc: RawConfig): ChantControlSettings | undefined {
  const c = doc.control;
  if (typeof c === "string") return { repo: controlRepoKey(c), op: OP_NAME };
  if (!isObject(c) || typeof c.repo !== "string") return undefined;
  const out: Record<string, unknown> = { repo: controlRepoKey(c.repo), op: typeof c.op === "string" ? c.op : OP_NAME };
  for (const [key, chant] of Object.entries(CONTROL_KEYS)) {
    if (key === "repo" || key === "op") continue;
    if (typeof c[key] === "string") out[chant] = c[key];
  }
  return out as unknown as ChantControlSettings;
}

export const control: ConfigGroup = {
  name: "control",
  keys: ["control"],
  schema: {
    control: {
      description: "The control repo this repository tells after each update on merge: its project key or URL, or a mapping.",
      oneOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          required: ["repo"],
          properties: {
            repo: { type: "string", description: "The control repo, as host/owner/name or its https URL." },
            op: { type: "string", description: `The Op the control repo runs on this repository's dependents. Default ${OP_NAME}.` },
            member: { type: "string", description: "This repository's name in the control repo's workspace. Default the repository's name." },
            forge: { type: "string", enum: [...CONTROL_FORGES], description: "The control repo's forge, when its host does not say." },
            token_secret: { type: "string", description: "The secret holding the dispatch token. Default CHANT_CONTROL_TOKEN." },
            read_token_secret: { type: "string", description: "The secret holding a read-only token for the control repo. Default CHANT_CONTROL_READ_TOKEN." },
            ref: { type: "string", description: "The branch a GitLab or Forgejo dispatch runs on. Default main." },
            api_base: { type: "string", description: "The forge's REST base, when the host's usual one is not it." },
          },
        },
      ],
    },
  },
  check(doc) {
    const c = doc.control;
    if (c === undefined) return [];
    if (typeof c === "string") return controlRepoKey(c).split("/").length >= 3 ? [] : [error("control", `${c} names no host/owner/name`)];
    if (!isObject(c)) return [error("control", "must be the control repo's project key, or a mapping with repo")];
    const out: ConfigProblem[] = [...onlyKeys(c, Object.keys(CONTROL_KEYS), "control")];
    if (typeof c.repo !== "string") out.push(error("control.repo", "must name the control repo, such as github.com/acme/infra-control"));
    else if (controlRepoKey(c.repo).split("/").length < 3) out.push(error("control.repo", `${c.repo} names no host/owner/name`));
    for (const key of Object.keys(CONTROL_KEYS)) {
      if (key !== "repo" && c[key] !== undefined && typeof c[key] !== "string") out.push(error(`control.${key}`, "must be a string"));
    }
    out.push(...oneOf(c.forge, CONTROL_FORGES, "control.forge"));
    if (typeof c.token_secret === "string" && c.token_secret === c.read_token_secret) {
      out.push(error("control.read_token_secret", "must not be the dispatch token's secret: the preview job runs the change's code"));
    }
    return out;
  },
  translate(doc, out) {
    const c = controlOf(doc);
    if (c) out.pipeline.control = c;
  },
};
