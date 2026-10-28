---
title: 'Tips'
description: 'Each tip id the report can print, and the fix for it.'
---

`plywood tips` prints every tip, and `plywood tips <id>` one of them.

| Tip | Means | Fix |
|---|---|---|
| `rename-without-aliases` | a resource is deleted and one of the same type is created under a new name or parent, with no `aliases` linking them | add `aliases: [{ name: "<old name>" }]` (or the old parent) so the update renames it in place |
| `replace-on-name` | a property change replaces a named resource | check the replacement is wanted, or add `deleteBeforeReplace` |
| `unknown-in-apply` | a resource registers inside `apply()`, so the preview cannot list it and the note shows it as may register at up | register it outside `apply()` where you can, or review the row in the note; see [Resources registered inside apply()](/plywood/guides/resources-registered-at-up/) |
| `secret-in-plain-config` | a config value looks like a secret | set it with `pulumi config set --secret` |
| `no-protect-on-data` | a database or bucket has no `protect` | add `protect: true` |
