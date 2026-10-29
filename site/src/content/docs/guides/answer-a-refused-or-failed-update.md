---
title: 'Read why an update stopped'
description: 'A refused wave posts its change since the approval, and a failed update posts the failure.'
---

A stopped wave gets a comment on the pull request that merged its commit. With no such pull request the comment goes on an issue.

| Event | Key | Default | Comment |
|---|---|---|---|
| a wave refused for a moved preview, a hold or a decline | `respond.wave_refused` | `diff` | each change that differs from the approved preview, or the holder |
| a failed update | `respond.apply_failed` | `triage` | the failed stacks and resources with the engine's error |
| a description that leaves out deletes or replaces | `respond.description` | `off` | with `check`, the deletes and replaces it leaves out |

`off` turns a comment off. A later run edits the same comment.

The description check asks a decide service. Name a `decide.backends` entry of `chant.config.ts` and its pinned model:

```yaml
respond:
  description: check
decide:
  backend: laya
  model: laya-2026-10
```

The check reads `chant.config.ts` at the target branch, so a pull request cannot change the service. It only comments and never gates an update.

The waves workflow reads `wave_refused` and `apply_failed` from the waves spec `plywood ci` writes. `plywood ci` also puts all three keys on the pull request's own jobs. `decide` reaches those jobs only with `description: check`; `plywood check` warns when it is set without the check, and `plywood ci` leaves it off.
