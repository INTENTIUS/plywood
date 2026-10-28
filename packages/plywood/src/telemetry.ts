/**
 * plywood.yml's `telemetry` as the variables chant's OTLP exporter reads
 * (chant#4555): plywood's bin sets them before its first call into chant,
 * and a variable the job already sets wins. The exporter names every span
 * attribute with plywood's words' prefix (`plywood.stack`,
 * `plywood.up.result`); when the installed chant exports `configureOtlp`,
 * the bin passes the prefix too.
 *
 * A config that cannot be read sets nothing: the command that reads it
 * reports the problem itself.
 */
import { chantProduct } from "./chant-product";
import { telemetryOf } from "./config/observe";
import { findConfig, loadConfig } from "./config/index";
import { PRODUCT } from "./words";

/** The OTEL_* variables plywood.yml's telemetry adds to `env`, leaving any the job set. */
export function telemetryEnv(doc: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, string> {
  const t = telemetryOf(doc);
  const out: Record<string, string> = {};
  const set = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== "" && env[k] === undefined) out[k] = v;
  };
  if (!t.traces) {
    set("OTEL_TRACES_EXPORTER", "none");
    return out;
  }
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined) set("OTEL_EXPORTER_OTLP_ENDPOINT", t.endpoint);
  if (t.headersEnv) set("OTEL_EXPORTER_OTLP_HEADERS", env[t.headersEnv]);
  if (t.endpoint !== undefined || env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT !== undefined) set("OTEL_SERVICE_NAME", t.serviceName);
  return out;
}

/** Sets plywood.yml's telemetry variables in `env` (the process's, in the bin) and configures chant's exporter with plywood's prefix. */
export async function applyTelemetry(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  let added: Record<string, string> = {};
  try {
    const file = findConfig(cwd);
    if (file) added = telemetryEnv(loadConfig(file).doc, env);
  } catch {
    return {};
  }
  Object.assign(env, added);
  const chant = (await chantProduct()) as unknown as { configureOtlp?: (o: { prefix?: string; env?: NodeJS.ProcessEnv }) => unknown } | undefined;
  if (chant && typeof chant.configureOtlp === "function") chant.configureOtlp({ prefix: PRODUCT, env });
  return added;
}
