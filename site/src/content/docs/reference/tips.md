---
title: 'Tips'
description: 'Each tip id the report can print, and the fix for it.'
needs: [plywood#6]
draft: true
---

| Tip | Means | Fix |
|---|---|---|
| `replace-on-name` | a property change replaces a named resource | check the replacement is wanted, or add `deleteBeforeReplace` |
| `unknown-in-apply` | a resource registers inside `apply()` | see [Resources registered inside apply()](/plywood/guides/resources-registered-at-up/) |
| `secret-in-plain-config` | a config value looks like a secret | set it with `pulumi config set --secret` |
| `no-protect-on-data` | a database or bucket has no `protect` | add `protect: true` |
