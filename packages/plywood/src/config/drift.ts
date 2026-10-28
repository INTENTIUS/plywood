/**
 * `drift` and `respond`: the scheduled drift check and what it does when a
 * stack has drifted (plywood#8).
 *
 *   drift.schedule   a five-field cron line; the scheduled drift job runs on it
 *   drift.stacks     the stacks (or project/* globs) the job reads; every stack when absent
 *   respond.drift    issue (default): one issue per drifted stack, edited on
 *                    each run and closed by a clean one;
 *                    pull-request: the issue, and the drift agent's pull
 *                    request that brings the program in line (plywood#19);
 *                    up: the issue, and an update of the waves holding the
 *                    drifted stacks, through each wave's gate;
 *                    none: the job's exit code only
 *     -> pipeline.drift, which `plywood ci` writes as chant's scheduled Op
 *        jobs (one PulumiWatchOp per stack) and `plywood drift` reads
 *
 * The read itself is chant's (`chant workspace drift`, the pulumi lexicon's
 * `readDrift`): `pulumi refresh --preview-only` per resource on stock
 * Pulumi, `plunge drift --resource <urn> --stream` on plunge, over the
 * export the last update stored under refs/chant/snapshots (chant#4546).
 */
import { globMatches } from "./images";
import { stacksOf } from "./stacks";
import { error, isObject, oneOf, onlyKeys, stringList, warning, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

export const DRIFT_RESPONSES = ["issue", "pull-request", "up", "none"] as const;
export type DriftResponse = (typeof DRIFT_RESPONSES)[number];
export const DEFAULT_DRIFT_RESPONSE: DriftResponse = "issue";

/** Five cron fields, each a number, a range, a list, a step or `*`. */
const CRON_FIELD = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*$/;

export function isCron(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const fields = v.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

/** What plywood hands the drift job and `plywood drift`. */
export interface DriftSettings {
  schedule?: string;
  /** The stacks the scheduled job reads, by name. */
  stacks: string[];
  respond: DriftResponse;
}

/** `respond.drift`, or the default. */
export function driftResponseOf(doc: RawConfig): DriftResponse {
  const r = isObject(doc.respond) ? doc.respond.drift : undefined;
  return typeof r === "string" && (DRIFT_RESPONSES as readonly string[]).includes(r) ? (r as DriftResponse) : DEFAULT_DRIFT_RESPONSE;
}

/** The stacks `drift.stacks` picks from those plywood.yml lists; all of them when absent. */
export function driftStacksOf(doc: RawConfig): string[] {
  const listed = Object.keys(stacksOf(doc));
  const d = isObject(doc.drift) ? doc.drift : {};
  if (!Array.isArray(d.stacks)) return listed;
  const globs = d.stacks.filter((s): s is string => typeof s === "string");
  return listed.filter((name) => globs.some((g) => globMatches(g, name)));
}

export function driftSettingsOf(doc: RawConfig): DriftSettings {
  const d = isObject(doc.drift) ? doc.drift : {};
  return {
    ...(isCron(d.schedule) ? { schedule: d.schedule.trim() } : {}),
    stacks: driftStacksOf(doc),
    respond: driftResponseOf(doc),
  };
}

export const drift: ConfigGroup = {
  name: "drift",
  keys: ["drift", "respond"],
  schema: {
    drift: {
      type: "object",
      additionalProperties: false,
      description: "The scheduled drift check. Off when absent.",
      properties: {
        schedule: { type: "string", description: "A five-field cron line, such as \"0 6 * * *\"; the drift job runs on it." },
        stacks: { type: "array", items: { type: "string" }, description: "The stacks the job reads, by name or project/* glob. Every stack when absent." },
      },
    },
    respond: {
      type: "object",
      additionalProperties: false,
      description: "What plywood does about a finding.",
      properties: {
        drift: {
          type: "string",
          enum: [...DRIFT_RESPONSES],
          default: DEFAULT_DRIFT_RESPONSE,
          description: "issue: one issue per drifted stack; pull-request: the issue and the drift agent's pull request; up: the issue and a gated update; none: the exit code only.",
        },
      },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    if (doc.drift !== undefined) {
      if (!isObject(doc.drift)) out.push(error("drift", "must be a mapping with a schedule"));
      else {
        const d = doc.drift;
        out.push(...onlyKeys(d, ["schedule", "stacks"], "drift"), ...stringList(d.stacks, "drift.stacks"));
        if (d.schedule === undefined) out.push(warning("drift", "has no schedule, so no job reads drift; plywood drift still runs by hand"));
        else if (!isCron(d.schedule)) out.push(error("drift.schedule", "is a five-field cron line, such as \"0 6 * * *\""));
        if (Array.isArray(d.stacks) && isObject(doc.stacks) && driftStacksOf(doc).length === 0) {
          out.push(error("drift.stacks", "names none of the stacks under stacks"));
        }
      }
    }
    if (doc.respond !== undefined) {
      if (!isObject(doc.respond)) out.push(error("respond", "must be a mapping, such as respond: { drift: issue }"));
      else {
        out.push(...onlyKeys(doc.respond, ["drift"], "respond"), ...oneOf(doc.respond.drift, DRIFT_RESPONSES, "respond.drift"));
        if (doc.respond.drift === "up" && doc.gate === "never") {
          out.push(warning("respond.drift", "is up and gate is never, so a drifted stack updates with nobody approving"));
        }
      }
    }
    return out;
  },
  translate(doc, out) {
    if (doc.drift === undefined && doc.respond === undefined) return;
    out.pipeline.drift = driftSettingsOf(doc);
  },
};
