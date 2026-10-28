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
 *   drift.audit_log  aws or aws:<region>, or a stack glob to one: the
 *                    CloudTrail `plywood drift` reads to name who changed
 *                    each drifted attribute (chant#4632's ci-audit)
 *
 *   respond.wave_refused  diff (default) or off: a wave refused because its
 *                         preview moved, a hold or a decline posts the diff
 *                         against the approved preview (chant#4629)
 *   respond.apply_failed  triage (default) or off: a failed update posts the
 *                         stacks and resources that failed, with the error
 *   respond.description   off (default) or check: a pull request whose
 *                         description leaves out what its preview deletes or
 *                         replaces is flagged; it asks the `decide` service
 *   decide.backend        the chant.config `decide.backends` entry the
 *                         description check asks, read at the target branch
 *   decide.model          the pinned model id
 *     -> pipeline.respond and pipeline.decide, chant's `respond` and
 *        `decide` options of the product pipeline (src/stages.ts)
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

/** The pipeline events plywood.yml's respond names beside drift, plywood's key to chant's event and its modes, default first (chant `CI_RESPONSES`). */
export const EVENT_RESPONSES = {
  wave_refused: { event: "wave-refused", modes: ["diff", "off"] },
  apply_failed: { event: "apply-failed", modes: ["triage", "off"] },
  description: { event: "description", modes: ["off", "check"] },
} as const;
export type EventKey = keyof typeof EVENT_RESPONSES;
const EVENT_KEYS = Object.keys(EVENT_RESPONSES) as EventKey[];
export const RESPOND_KEYS = ["drift", ...EVENT_KEYS] as const;
export const DECIDE_KEYS = ["backend", "model"] as const;

/** The responses plywood.yml sets, by chant's event name; an event left out takes chant's default. */
export function eventResponsesOf(doc: RawConfig): Record<string, string> {
  const r = isObject(doc.respond) ? doc.respond : {};
  const out: Record<string, string> = {};
  for (const k of EVENT_KEYS) {
    const v = r[k];
    if (typeof v === "string" && (EVENT_RESPONSES[k].modes as readonly string[]).includes(v)) out[EVENT_RESPONSES[k].event] = v;
  }
  return out;
}

/** `decide`, when it names both a backend and a model. */
export function decideOf(doc: RawConfig): { backend: string; model: string } | undefined {
  const d = isObject(doc.decide) ? doc.decide : {};
  return typeof d.backend === "string" && d.backend !== "" && typeof d.model === "string" && d.model !== "" ? { backend: d.backend, model: d.model } : undefined;
}

/** `drift.audit_log` as stack glob to chant's `--audit-log` text (`*` for every stack). */
export function auditLogsOf(doc: RawConfig): Record<string, string> | undefined {
  const d = isObject(doc.drift) ? doc.drift : {};
  if (typeof d.audit_log === "string") return { "*": d.audit_log };
  if (isObject(d.audit_log)) return Object.fromEntries(Object.entries(d.audit_log).filter((e): e is [string, string] => typeof e[1] === "string"));
  return undefined;
}

/** `aws`, or `aws:<region>`. */
const AUDIT_LOG = /^aws(?::[a-z0-9-]+)?$/;

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
  /** `drift.audit_log`: stack glob to the audit log (`aws[:<region>]`) the attribution reads. */
  auditLogs?: Record<string, string>;
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
    ...(auditLogsOf(doc) ? { auditLogs: auditLogsOf(doc) } : {}),
  };
}

export const drift: ConfigGroup = {
  name: "drift",
  keys: ["drift", "respond", "decide"],
  schema: {
    drift: {
      type: "object",
      additionalProperties: false,
      description: "The scheduled drift check. Off when absent.",
      properties: {
        schedule: { type: "string", description: "A five-field cron line, such as \"0 6 * * *\"; the drift job runs on it." },
        stacks: { type: "array", items: { type: "string" }, description: "The stacks the job reads, by name or project/* glob. Every stack when absent." },
        audit_log: {
          description: "aws or aws:<region>, or a stack glob to one: the CloudTrail plywood drift reads to name who changed each drifted attribute.",
          oneOf: [
            { type: "string", pattern: AUDIT_LOG.source },
            { type: "object", additionalProperties: { type: "string", pattern: AUDIT_LOG.source } },
          ],
        },
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
        wave_refused: { type: "string", enum: [...EVENT_RESPONSES.wave_refused.modes], default: "diff", description: "diff: a refused wave posts the diff against the approved preview; off: nothing." },
        apply_failed: { type: "string", enum: [...EVENT_RESPONSES.apply_failed.modes], default: "triage", description: "triage: a failed update posts the stacks and resources that failed, with the error; off: nothing." },
        description: { type: "string", enum: [...EVENT_RESPONSES.description.modes], default: "off", description: "check: flag a pull request whose description leaves out what its preview deletes or replaces. Needs decide." },
      },
    },
    decide: {
      type: "object",
      additionalProperties: false,
      description: "The decide service respond.description: check asks.",
      properties: {
        backend: { type: "string", description: "A decide.backends entry of chant.config, read at the target branch." },
        model: { type: "string", description: "The pinned model id." },
      },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    if (doc.drift !== undefined) {
      if (!isObject(doc.drift)) out.push(error("drift", "must be a mapping with a schedule"));
      else {
        const d = doc.drift;
        out.push(...onlyKeys(d, ["schedule", "stacks", "audit_log"], "drift"), ...stringList(d.stacks, "drift.stacks"));
        if (d.audit_log !== undefined) {
          const values = typeof d.audit_log === "string" ? [d.audit_log] : isObject(d.audit_log) ? Object.values(d.audit_log) : undefined;
          if (!values) out.push(error("drift.audit_log", "is aws, aws:<region>, or a stack glob to one"));
          else for (const v of values) if (typeof v !== "string" || !AUDIT_LOG.test(v)) out.push(error("drift.audit_log", `is ${JSON.stringify(v)}; give aws or aws:<region>, the CloudTrail the attribution reads`));
        }
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
        out.push(...onlyKeys(doc.respond, RESPOND_KEYS, "respond"), ...oneOf(doc.respond.drift, DRIFT_RESPONSES, "respond.drift"));
        for (const k of EVENT_KEYS) out.push(...oneOf(doc.respond[k], EVENT_RESPONSES[k].modes, `respond.${k}`));
        if (doc.respond.description === "check" && !decideOf(doc)) out.push(error("respond.description", "is check, which asks a decide service; set decide.backend and decide.model"));
        if (doc.respond.drift === "up" && doc.gate === "never") {
          out.push(warning("respond.drift", "is up and gate is never, so a drifted stack updates with nobody approving"));
        }
      }
    }
    if (doc.decide !== undefined) {
      if (!isObject(doc.decide)) out.push(error("decide", "must be a mapping of backend and model"));
      else {
        out.push(...onlyKeys(doc.decide, DECIDE_KEYS, "decide"));
        for (const k of DECIDE_KEYS) if (typeof doc.decide[k] !== "string" || doc.decide[k] === "") out.push(error(`decide.${k}`, k === "backend" ? "names a decide.backends entry of chant.config" : "names the pinned model id"));
        if (!(isObject(doc.respond) && doc.respond.description === "check")) out.push(warning("decide", "is set and respond.description is not check, so nothing asks it"));
      }
    }
    return out;
  },
  translate(doc, out) {
    const events = eventResponsesOf(doc);
    if (Object.keys(events).length) out.pipeline.respond = events;
    const decide = decideOf(doc);
    if (decide && events.description === "check") out.pipeline.decide = decide;
    if (doc.drift === undefined && !(isObject(doc.respond) && doc.respond.drift !== undefined)) return;
    out.pipeline.drift = driftSettingsOf(doc);
  },
};
