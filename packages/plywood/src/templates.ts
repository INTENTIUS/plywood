/**
 * plywood's init templates, in `packages/plywood/templates/` (shipped in the
 * package). This module sits directly under `src/` so `../templates/`
 * resolves to the same directory from the source (`src/templates.ts`) and
 * from the bundle (`dist/plywood.mjs`).
 *
 *   plywood.yml          the file init writes; `{{keys}}` takes the keys
 *   chant.config.ts.tmpl the chant project beside the stacks
 *   agent-prompt.md      the paste-in prompt for a coding agent
 */
import { readFileSync } from "node:fs";

export type TemplateName = "plywood.yml" | "chant.config.ts.tmpl" | "agent-prompt.md";

/** A template's text. */
export function template(name: TemplateName): string {
  return readFileSync(new URL(`../templates/${name}`, import.meta.url), "utf8");
}

/** `text` with each `{{key}}` replaced by its value. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (key in values ? values[key]! : all));
}
