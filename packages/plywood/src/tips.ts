/**
 * Tip ids and their words, as reference/tips.md lists them. A tip names a
 * pattern in a preview and the fix for it. plywood holds the words; finding
 * the pattern in a change set belongs to chant's pulumi lexicon, which reads
 * the preview (CONTRIBUTING.md). `plywood tips [<id>]` prints them.
 */

export interface Tip {
  id: string;
  /** What the preview shows. */
  means: string;
  /** What to do about it. */
  fix: string;
}

export const TIPS: readonly Tip[] = [
  {
    id: "rename-without-aliases",
    means: "a resource is deleted and one of the same type is created under a new name or parent, with no `aliases` linking them",
    fix: "add `aliases: [{ name: \"<old name>\" }]` (or the old parent) so the update renames it in place",
  },
  {
    id: "replace-on-name",
    means: "a property change replaces a named resource",
    fix: "check the replacement is wanted, or add `deleteBeforeReplace`",
  },
  {
    id: "unknown-in-apply",
    means: "a resource registers inside `apply()`, so the preview cannot list it and the note shows it as may register at up",
    fix: "register it outside `apply()` where you can, or review the row in the note",
  },
  {
    id: "secret-in-plain-config",
    means: "a config value looks like a secret",
    fix: "set it with `pulumi config set --secret`",
  },
  {
    id: "no-protect-on-data",
    means: "a database or bucket has no `protect`",
    fix: "add `protect: true`",
  },
];

/** The tip with `id`, if plywood knows it. */
export function tipById(id: string): Tip | undefined {
  return TIPS.find((t) => t.id === id);
}

/** The lines `plywood tips` prints: every tip, or the one named. */
export function tipLines(tips: readonly Tip[] = TIPS): string[] {
  return tips.flatMap((t) => [`${t.id}`, `  means  ${t.means}`, `  fix    ${t.fix}`]);
}
