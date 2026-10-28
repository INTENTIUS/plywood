/**
 * plywood's scenarios on chant's harness (plywood#22's claims, plywood#25),
 * and plywood's own lint of them on top of the harness's `lintScenario`.
 *
 * | scenario      | claim                    | plunge claims its row records                          |
 * |---------------|--------------------------|--------------------------------------------------------|
 * | pw-disjoint   | plunge/disjoint-updates  | C5's product line, markers, plungeTimings (plunge#55)  |
 * | pw-moved-plan | plunge/saved-plan-moved  | C3, a saved plan refused with exit 40                  |
 * | pw-adopt      | plunge/adopt-stock-stack | adopt                                                  |
 *
 * plywood#22's stock Pulumi claims run on the bench's two stock stacks,
 * prod-us and prod-eu (S3 state on floci), which the seed deploys:
 *
 * | scenario         | claim              | what the BREAK arm changes                      |
 * |------------------|--------------------|-------------------------------------------------|
 * | pw-one-note      | preview/one-note   | the two stacks take different changes           |
 * | pw-moved-preview | gate/moved-preview | the push after the approval leaves the preview  |
 * | pw-canary        | wave/canary        | both prod stacks in one wave                    |
 * | pw-drift         | drift/issue        | the change by hand sets the value it already has |
 *
 * The three that update put the prod stacks ahead of dev and staging in the
 * waves (base overlays stock-first*, laid by `plywood-e2e configure`, which
 * runs plywood ci), so their waves never wait on staging, which plunge
 * reads only after pw-adopt.
 *
 * | scenario  | claim                | what the BREAK arm changes                                  |
 * |-----------|----------------------|-------------------------------------------------------------|
 * | pw-action | action/gated-replace | main changes the command's input after the approval         |
 *
 * pw-action (plywood#39, plywood#44) runs on prod-us's command resource
 * rotate, which the seed adds to the shop program (./action.ts), with the
 * command provider from plywood's images.
 *
 * plywood#22's `pulumi-cloud/token` is a real-account maintainer run and
 * stays out of the harness.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_URL } from "./bench";
import { expandWord } from "./checks";
import { COMMANDS } from "./ports";
import type { Scenario } from "./harness";

export const SCENARIOS_DIR = join(import.meta.dirname, "scenarios");
export const OVERLAYS_DIR = join(SCENARIOS_DIR, "overlays");
export const BASE_OVERLAYS_DIR = join(SCENARIOS_DIR, "base-overlays");

/** Each scenario's claim id, the id its row records. */
export const SCENARIO_CLAIMS: Readonly<Record<string, string>> = {
  "pw-disjoint": "plunge/disjoint-updates",
  "pw-moved-plan": "plunge/saved-plan-moved",
  "pw-adopt": "plunge/adopt-stock-stack",
  "pw-one-note": "preview/one-note",
  "pw-moved-preview": "gate/moved-preview",
  "pw-canary": "wave/canary",
  "pw-drift": "drift/issue",
  "pw-action": "action/gated-replace",
};

/** The scenario files in `dir`, by id. */
export function scenarioFiles(dir = SCENARIOS_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".json")) out[f.slice(0, -".json".length)] = join(dir, f);
  return out;
}

export function readScenario(id: string, dir = SCENARIOS_DIR): Scenario {
  const f = join(dir, `${id}.json`);
  if (!existsSync(f)) throw new Error(`no scenario ${id} in ${dir}`);
  return JSON.parse(readFileSync(f, "utf8")) as Scenario;
}

/**
 * What plywood holds its scenarios to, beyond the harness's lint: the file
 * is named for its id, the claim is the one plywood lists for it, the
 * product is plywood, the report URL is the bench's, every overlay and base
 * overlay exists (those a configure or push step names, in either arm,
 * too), every `plywood-e2e` command is one plywood runs, and each `${NAME}`
 * word has a default for the plain arm.
 */
export function lintPlywoodScenario(file: string, s: Scenario, dirs = { overlays: OVERLAYS_DIR, base: BASE_OVERLAYS_DIR }): string[] {
  const out: string[] = [];
  const id = file.replace(/^.*\//, "").replace(/\.json$/, "");
  if (s.id !== id) out.push(`${file}: id ${s.id} is not the file's name`);
  if (s.product !== "plywood") out.push(`${file}: product is ${s.product}, not plywood`);
  if (SCENARIO_CLAIMS[s.id] === undefined) out.push(`${file}: ${s.id} is not in SCENARIO_CLAIMS`);
  else if (s.claim !== SCENARIO_CLAIMS[s.id]) out.push(`${file}: claim ${s.claim} is not ${SCENARIO_CLAIMS[s.id]}`);
  if (s.reportUrl !== REPORT_URL) out.push(`${file}: reportUrl is not the bench's ${REPORT_URL}`);
  if (s.break?.env?.BREAK !== "1") out.push(`${file}: the BREAK arm does not set BREAK=1`);
  const overlay = (name: string, where: string) => {
    if (!existsSync(join(dirs.overlays, `${name}.json`))) out.push(`${file}: ${where} names overlay ${name}, which e2e/scenarios/overlays lacks`);
  };
  if (s.break?.overlay) overlay(s.break.overlay, "the BREAK arm");
  const base = s.break?.env?.PLYWOOD_E2E_BASE_OVERLAY;
  if (base && !existsSync(join(dirs.base, `${base}.json`))) out.push(`${file}: the BREAK arm names base overlay ${base}, which e2e/scenarios/base-overlays lacks`);
  for (const step of s.steps ?? []) {
    if ((step.do === "open" || step.do === "open-concurrent") && step.overlay) overlay(step.overlay, `step ${step.id}`);
    if (step.do !== "out-of-band") continue;
    const [first, name] = step.command;
    if (first === "plywood-e2e" && (name === undefined || COMMANDS[name] === undefined)) out.push(`${file}: step ${step.id} runs plywood-e2e ${name ?? ""}, which is not a command`);
    for (const w of step.command) {
      for (const m of w.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/g)) {
        if (!m[2]) out.push(`${file}: step ${step.id} names \${${m[1]}} with no default, so the plain arm has no value for it`);
      }
    }
    if (!(step.expect ?? []).some((e) => "exit" in e)) out.push(`${file}: out-of-band step ${step.id} expects no exit code, so its check is never read`);
    // The overlay a configure or push step names, in both arms.
    const named = first === "plywood-e2e" && (name === "configure" || name === "push") ? step.command[name === "configure" ? 2 : 3] : undefined;
    if (named !== undefined) {
      for (const env of [{}, s.break?.env ?? {}]) {
        let value: string;
        try {
          value = expandWord(named, env);
        } catch {
          continue; // reported above as a name with no default
        }
        if (name === "configure" && !existsSync(join(dirs.base, `${value}.json`))) out.push(`${file}: step ${step.id} configures base overlay ${value}, which e2e/scenarios/base-overlays lacks`);
        if (name === "push") overlay(value, `step ${step.id}`);
      }
    }
  }
  return out;
}
