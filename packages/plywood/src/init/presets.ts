/**
 * The presets `plywood init` offers: a few starting points for plywood.yml,
 * each a small set of plywood keys. Approval binds to the pull request's
 * preview in every preset (chant#4550 ruling B, plywood's `pull-request`
 * preset), so a preset chooses when updates run and when a wave waits, and
 * never per-wave approval.
 *
 * Beside them, init switches on what the repository already uses:
 * `.pre-commit-config.yaml` becomes a check hook (chant#4556's
 * `ci.hooks.check`), so `plywood check` runs the team's own hooks.
 */
import type { RawConfig } from "../config/types";

export interface Preset {
  name: PresetName;
  summary: string;
  /** The plywood.yml keys the preset writes; empty means plywood's defaults. */
  keys: RawConfig;
}

export const PRESET_NAMES = ["merge", "before-merge", "approve-all"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];
export const DEFAULT_PRESET: PresetName = "merge";

export const PRESETS: readonly Preset[] = [
  {
    name: "merge",
    summary: "preview on every pull request, update on merge; a wave waits for an approval when its preview deletes or replaces",
    keys: {},
  },
  {
    name: "before-merge",
    summary: "preview on every pull request, update from a /plywood up comment before merge, once the pull request is approved and mergeable",
    keys: { apply: { when: "pull-request" } },
  },
  {
    name: "approve-all",
    summary: "preview on every pull request, update on merge; every wave that changes something waits for an approval",
    keys: { gate: "always" },
  },
];

export function presetByName(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

/** `--gate` values: plywood.yml's, plus `destroy`, which the pages also use for `on-destructive`. */
export function gateFlag(v: string): "always" | "on-destructive" | "never" | undefined {
  if (v === "destroy") return "on-destructive";
  return v === "always" || v === "on-destructive" || v === "never" ? v : undefined;
}

/** The check hook a `.pre-commit-config.yaml` turns into (chant `OpWaveHook`). */
export function preCommitHook(): { name: string; command: string[] } {
  return { name: "pre-commit", command: ["pre-commit", "run", "--all-files", "--show-diff-on-failure"] };
}
