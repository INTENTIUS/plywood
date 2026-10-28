/**
 * `notify`, `telemetry` and `reports`: who hears about a run, where its trace
 * goes, and where its report is kept (plywood#20).
 *
 *   notify.slack.webhook   the variable holding a Slack incoming webhook URL
 *   notify.teams.webhook   the same for Microsoft Teams
 *   notify.webhook         { url, key }: the variables holding a generic
 *                          webhook's URL and the key its events are signed with
 *   notify.on              wave-waiting, up-refused, up-failed, drift
 *                          (default: all four)
 *   notify.relay           the variable holding the relay key: a waiting
 *                          wave's Slack message gets Approve and Decline
 *                          buttons, and its Teams card the reply that
 *                          approves, which `plywood notify relay` receives
 *                          and records on the ledger (chant#4611)
 *     -> the waves spec's `notify` (chant `NotifyConfig`, chant#3761): each
 *        event is a `chant.notify/v1` message, signed for the generic webhook,
 *        with `source: plywood` and plywood's summary (the words' `notify`
 *        slot, chant#4610)
 *
 *   telemetry.endpoint     the OTLP/HTTP base URL; chant adds /v1/traces
 *   telemetry.headers_env  the variable holding OTLP headers (k=v,k2=v2)
 *   telemetry.service_name OTEL_SERVICE_NAME, default plywood
 *   telemetry.traces       false turns traces off
 *     -> the OTEL_* variables chant's exporter reads (chant#4555), set by
 *        plywood's bin before it calls chant (src/telemetry.ts); a variable
 *        the job already sets wins. Span attributes carry the `plywood.`
 *        prefix from plywood's words.
 *
 *   reports.url            ci.reportUrl: s3://, gs://, az:// or file://, where
 *                          chant keeps each run's HTML report (chant#4554)
 *
 * Every secret is named by its variable, never written in plywood.yml.
 */
import { error, isObject, onlyKeys, warning, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

/** plywood's notify event words and chant's (`NOTIFY_EVENTS`). */
export const NOTIFY_EVENTS = { "wave-waiting": "waiting", "up-refused": "refused", "up-failed": "failed", drift: "drift" } as const;
export type NotifyWord = keyof typeof NOTIFY_EVENTS;
export type ChantNotifyEvent = (typeof NOTIFY_EVENTS)[NotifyWord];

/** chant's `NotifyConfig`: every value names a variable. */
export interface ChantNotifyConfig {
  webhook?: string;
  key?: string;
  slack?: string;
  teams?: string;
  events?: ChantNotifyEvent[];
  /** The variable holding the relay key (chant#4611). A chant before it refuses the setting, so plywood init leaves it out there ({@link notifyForChant}). */
  relay?: string;
}

/**
 * The notify config for the installed chant: `relay` only when chant has
 * the relay (`NOTIFY_RELAY_FLOOR` on @intentius/chant/ci-product), since an
 * older chant refuses a setting it does not know.
 */
export function notifyForChant(notify: ChantNotifyConfig, chant: { NOTIFY_RELAY_FLOOR?: string } | undefined): ChantNotifyConfig {
  if (notify.relay === undefined || typeof chant?.NOTIFY_RELAY_FLOOR === "string") return { ...notify };
  const { relay: _relay, ...rest } = notify;
  return rest;
}

export interface TelemetrySettings {
  endpoint?: string;
  headersEnv?: string;
  serviceName: string;
  traces: boolean;
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEFAULT_SERVICE_NAME = "plywood";

/** The report URL schemes chant reads (`pr-report-url`); gs:// and az:// need chant#4554. */
export const REPORT_SCHEMES = ["s3", "gs", "az", "file"] as const;
const NEWER_SCHEMES = new Set(["gs", "az"]);

function variable(v: unknown, key: string): ConfigProblem[] {
  if (v === undefined) return [];
  return typeof v === "string" && VARIABLE.test(v) ? [] : [error(key, "names an environment variable, such as SLACK_WEBHOOK_URL; the URL or key itself never goes in plywood.yml")];
}

/** chant's notify config for plywood.yml, or undefined when it sets none. */
export function chantNotifyOf(doc: RawConfig): ChantNotifyConfig | undefined {
  const n = doc.notify;
  if (!isObject(n)) return undefined;
  const slack = isObject(n.slack) ? n.slack.webhook : undefined;
  const teams = isObject(n.teams) ? n.teams.webhook : undefined;
  const hook = isObject(n.webhook) ? n.webhook : {};
  const on = Array.isArray(n.on) ? (n.on as string[]).filter((w): w is NotifyWord => w in NOTIFY_EVENTS) : undefined;
  const out: ChantNotifyConfig = {
    ...(typeof hook.url === "string" ? { webhook: hook.url } : {}),
    ...(typeof hook.key === "string" ? { key: hook.key } : {}),
    ...(typeof slack === "string" ? { slack } : {}),
    ...(typeof teams === "string" ? { teams } : {}),
    ...(on ? { events: [...new Set(on.map((w) => NOTIFY_EVENTS[w]))] } : {}),
    ...(typeof n.relay === "string" ? { relay: n.relay } : {}),
  };
  return out.webhook || out.slack || out.teams ? out : undefined;
}

/** plywood.yml's telemetry, with its defaults. */
export function telemetryOf(doc: RawConfig): TelemetrySettings {
  const t = isObject(doc.telemetry) ? doc.telemetry : {};
  return {
    ...(typeof t.endpoint === "string" ? { endpoint: t.endpoint.replace(/\/+$/, "") } : {}),
    ...(typeof t.headers_env === "string" ? { headersEnv: t.headers_env } : {}),
    serviceName: typeof t.service_name === "string" ? t.service_name : DEFAULT_SERVICE_NAME,
    traces: t.traces !== false,
  };
}

const WEBHOOK_VAR = { type: "object", additionalProperties: false, required: ["webhook"], properties: { webhook: { type: "string", pattern: VARIABLE.source, description: "The variable holding the incoming webhook's URL." } } };

export const observe: ConfigGroup = {
  name: "notify, telemetry and reports",
  keys: ["notify", "telemetry", "reports"],
  schema: {
    notify: {
      type: "object",
      additionalProperties: false,
      description: "Chat and webhook messages when a wave waits, an update is refused or fails, or drift is found. Each value names a variable.",
      properties: {
        slack: WEBHOOK_VAR,
        teams: WEBHOOK_VAR,
        webhook: {
          type: "object",
          additionalProperties: false,
          required: ["url", "key"],
          description: "A generic webhook; each chant.notify/v1 event is signed with the key.",
          properties: {
            url: { type: "string", pattern: VARIABLE.source, description: "The variable holding the webhook's URL." },
            key: { type: "string", pattern: VARIABLE.source, description: "The variable holding the signing key." },
          },
        },
        on: { type: "array", items: { type: "string", enum: Object.keys(NOTIFY_EVENTS) }, description: "The events to send. Default: all of them." },
        relay: { type: "string", pattern: VARIABLE.source, description: "The variable holding the relay key. A waiting wave's Slack and Teams messages then carry the approval that plywood notify relay records." },
      },
    },
    telemetry: {
      type: "object",
      additionalProperties: false,
      description: "One OpenTelemetry trace per run over OTLP/HTTP, with a span per stack. OTEL_* variables in the job win over these.",
      properties: {
        endpoint: { type: "string", description: "The OTLP/HTTP base URL; /v1/traces is added." },
        headers_env: { type: "string", pattern: VARIABLE.source, description: "The variable holding the OTLP headers, k=v,k2=v2." },
        service_name: { type: "string", default: DEFAULT_SERVICE_NAME, description: "The trace's service.name." },
        traces: { type: "boolean", default: true, description: "false turns traces off." },
      },
    },
    reports: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      description: "Where each run's HTML report is kept.",
      properties: { url: { type: "string", description: "s3://<bucket>/<prefix>, gs://<bucket>/<prefix>, az://<account>/<container>/<prefix> or file://<dir>." } },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    const n = doc.notify;
    if (n !== undefined) {
      if (!isObject(n)) out.push(error("notify", "must be a mapping of slack, teams, webhook and on"));
      else {
        out.push(...onlyKeys(n, ["slack", "teams", "webhook", "on", "relay"], "notify"));
        if (n.relay !== undefined) {
          out.push(...variable(n.relay, "notify.relay"));
          // The relay answers a click in Slack or a reply in Teams; the generic webhook has neither.
          if (n.slack === undefined && n.teams === undefined) out.push(error("notify.relay", "needs notify.slack or notify.teams: approvals come back from a chat message"));
          else out.push(warning("notify.relay", "needs chant >= the release after 0.124.54 (chant#4611); plywood init leaves it out of the waves spec on a chant without the relay"));
        }
        for (const chat of ["slack", "teams"] as const) {
          const c = n[chat];
          if (c === undefined) continue;
          if (!isObject(c)) out.push(error(`notify.${chat}`, "is { webhook: <variable> }"));
          else out.push(...onlyKeys(c, ["webhook"], `notify.${chat}`), ...(c.webhook === undefined ? [error(`notify.${chat}.webhook`, "is required")] : variable(c.webhook, `notify.${chat}.webhook`)));
        }
        if (n.webhook !== undefined) {
          if (!isObject(n.webhook)) out.push(error("notify.webhook", "is { url: <variable>, key: <variable> }"));
          else {
            out.push(...onlyKeys(n.webhook, ["url", "key"], "notify.webhook"), ...variable(n.webhook.url, "notify.webhook.url"), ...variable(n.webhook.key, "notify.webhook.key"));
            // chant never posts an unsigned event to a generic webhook.
            for (const k of ["url", "key"] as const) if (n.webhook[k] === undefined) out.push(error(`notify.webhook.${k}`, "is required: the generic webhook's events are always signed"));
          }
        }
        if (n.on !== undefined) {
          if (!Array.isArray(n.on) || n.on.length === 0) out.push(error("notify.on", `is a list of ${Object.keys(NOTIFY_EVENTS).join(", ")}`));
          else for (const w of n.on) if (typeof w !== "string" || !(w in NOTIFY_EVENTS)) out.push(error("notify.on", `has ${JSON.stringify(w)}; the events are ${Object.keys(NOTIFY_EVENTS).join(", ")}`));
        }
        if (isObject(n) && n.slack === undefined && n.teams === undefined && n.webhook === undefined) out.push(error("notify", "names no slack, teams or webhook"));
      }
    }
    const t = doc.telemetry;
    if (t !== undefined) {
      if (!isObject(t)) out.push(error("telemetry", "must be a mapping of endpoint, headers_env, service_name and traces"));
      else {
        out.push(...onlyKeys(t, ["endpoint", "headers_env", "service_name", "traces"], "telemetry"), ...variable(t.headers_env, "telemetry.headers_env"));
        if (t.endpoint !== undefined && (typeof t.endpoint !== "string" || !/^https?:\/\/\S+$/.test(t.endpoint))) out.push(error("telemetry.endpoint", "must be an http or https URL"));
        if (typeof t.endpoint === "string" && /@|[?&](?:token|key)=/i.test(t.endpoint)) out.push(error("telemetry.endpoint", "carries a credential; put it in the variable telemetry.headers_env names"));
        if (t.service_name !== undefined && (typeof t.service_name !== "string" || t.service_name === "")) out.push(error("telemetry.service_name", "must be a string"));
        if (t.traces !== undefined && typeof t.traces !== "boolean") out.push(error("telemetry.traces", "is true or false"));
      }
    }
    const r = doc.reports;
    if (r !== undefined) {
      if (!isObject(r)) out.push(error("reports", "is { url }"));
      else {
        out.push(...onlyKeys(r, ["url"], "reports"));
        const scheme = typeof r.url === "string" ? /^([a-z0-9]+):\/\/\S+$/.exec(r.url)?.[1] : undefined;
        if (!scheme || !(REPORT_SCHEMES as readonly string[]).includes(scheme)) out.push(error("reports.url", `is a ${REPORT_SCHEMES.map((s) => `${s}://`).join(", ")} URL`));
        else if (NEWER_SCHEMES.has(scheme)) out.push(warning("reports.url", `${scheme}:// reports need chant >= the release after 0.124.54 (chant#4554); the pinned chant takes s3:// and file://`));
      }
    }
    return out;
  },
  translate(doc, out) {
    const notify = chantNotifyOf(doc);
    if (notify) out.pipeline.notify = notify;
    if (isObject(doc.reports) && typeof doc.reports.url === "string") out.ci.reportUrl = doc.reports.url;
  },
};
