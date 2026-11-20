/**
 * `cost`: the monthly estimate of each preview and the amount that holds a
 * wave. plywood prices nothing itself. The estimator is a command the
 * repository names, which reads each stack's preview JSON and prints the
 * monthly cost; chant runs it (chant#5334) and the pulumi lexicon's
 * `pulumiCostHold` (chant#5341) carries the same settings into the waves.
 * The keys are chant's `cost.*` rows (ci-product-config.mdx).
 *
 *   cost.command        ci.cost.command        the estimator's argv; names {planJson}
 *   cost.format         ci.cost.format         chant (default) or infracost
 *   cost.currency       ci.cost.currency       a three-letter code
 *   cost.approve_above  ci.cost.approveAbove   the monthly change above which a plan,
 *                                              and the wave, needs an approval of its own
 *
 * `approve_above` only adds an approval. A change over it, or a stack the
 * estimator could not price, waits for a person whatever the gate says, and
 * nothing here lets an update run without one. With no `cost` key nothing is
 * estimated.
 */
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

export const COST_FORMATS = ["chant", "infracost"] as const;
export type CostFormat = (typeof COST_FORMATS)[number];
export const DEFAULT_COST_FORMAT: CostFormat = "chant";

/** The placeholder every estimator command names: the stack's preview JSON. */
export const PLAN_JSON = "{planJson}";

/** `cost` as chant's `ci.cost` and `holds.cost` take it. */
export interface CostSettings {
  command: string[];
  format?: CostFormat;
  currency?: string;
  approveAbove?: number;
}

/** A command line as argv: split on spaces, a quote groups words. Null when a quote is left open. */
export function commandArgv(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

/** The estimator's argv from the key: a list, or a command line. */
function argvOf(command: unknown): string[] | null {
  if (typeof command === "string") return commandArgv(command);
  if (Array.isArray(command) && command.length > 0 && command.every((a) => typeof a === "string" && a !== "")) return command as string[];
  return null;
}

/** The cost settings the config holds, or undefined when `cost` is absent or does not check. */
export function costOf(doc: RawConfig): CostSettings | undefined {
  if (!isObject(doc.cost)) return undefined;
  const c = doc.cost;
  const command = argvOf(c.command);
  if (!command || command.length === 0) return undefined;
  return {
    command,
    // Always written: chant's own default for ci.cost is infracost, which reads no Pulumi preview.
    format: typeof c.format === "string" ? (c.format as CostFormat) : DEFAULT_COST_FORMAT,
    ...(typeof c.currency === "string" ? { currency: c.currency } : {}),
    ...(typeof c.approve_above === "number" ? { approveAbove: c.approve_above } : {}),
  };
}

export const cost: ConfigGroup = {
  name: "cost",
  keys: ["cost"],
  schema: {
    cost: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
          description: "The estimator: a command line, or a list of arguments. It names {planJson}, the stack's preview JSON, and prints the stack's monthly cost on standard output. {target} is the stack.",
        },
        format: { type: "string", enum: [...COST_FORMATS], default: DEFAULT_COST_FORMAT, description: "What the estimator prints: chant, { monthlyDelta, monthlyTotal?, pastMonthlyTotal?, currency? }, or infracost's JSON." },
        currency: { type: "string", pattern: "^[A-Z]{3}$", description: "The currency the amounts are in, as a three-letter code. Absent, the estimate's own, else USD." },
        approve_above: { type: "number", minimum: 0, description: "The monthly change above which a preview needs an approval of its own and a wave waits for one. A stack the estimator could not price counts as over. Absent, the estimate is shown and holds nothing." },
      },
    },
  },
  check(doc) {
    if (doc.cost === undefined) return [];
    if (!isObject(doc.cost)) return [error("cost", "must be a mapping with a command")];
    const c = doc.cost;
    const out: ConfigProblem[] = [...onlyKeys(c, ["command", "format", "currency", "approve_above"], "cost"), ...oneOf(c.format, COST_FORMATS, "cost.format")];
    const argv = argvOf(c.command);
    if (c.command === undefined) out.push(error("cost.command", "is the estimator, a command that reads the preview JSON; plywood ships none, so name yours"));
    else if (!argv || argv.length === 0) out.push(error("cost.command", "must be a command line or a non-empty list of arguments, with every quote closed"));
    else if (!argv.some((a) => a.includes(PLAN_JSON))) out.push(error("cost.command", `must name ${PLAN_JSON}, the stack's preview JSON`));
    if (c.currency !== undefined && (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency))) out.push(error("cost.currency", "must be a three-letter currency code, such as USD"));
    if (c.approve_above !== undefined && (typeof c.approve_above !== "number" || !Number.isFinite(c.approve_above) || c.approve_above < 0)) out.push(error("cost.approve_above", "must be a monthly amount of 0 or more"));
    return out;
  },
  translate(doc, out) {
    const settings = costOf(doc);
    if (!settings) return;
    out.ci.cost = { ...settings };
    // The hold needs an amount: with none, the estimate is shown and holds nothing.
    if (settings.approveAbove !== undefined) out.pipeline.cost = { ...settings };
  },
};
