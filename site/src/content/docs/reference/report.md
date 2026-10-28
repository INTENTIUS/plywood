---
title: 'The report'
description: 'The JSON each stage writes, with its schema version.'
---

The preview job writes `.chant/pr/pr-plan.json` and an update of a pull request writes `.chant/pr/pr-apply.json`. Beside the report sit `change-set.json` and the note, `pr-note.md`. The report is chant's pull request report, contract version 1 (`pr-report/v1`).

| Field | Holds |
|---|---|
| `stage` | `plan` on the pull request, `apply` for an update |
| `op`, `gate` | the gate's op, `pr-<n>` (or `pr-<n>-<stack>` for one stack), and the gate it waits on |
| `digest` | the change set's digest, the value an approval binds to |
| `status` | such as `planned`, `applied`, `waiting` or `refused`, with `refusal` and `message` saying why |
| `members` | one entry per stack in the change |
| `waves` | each wave the run reached, with the approval it applied or waits under |
| `policy`, `capabilityPolicy` | the Rego results, and each stack's CrossGuard findings |
| `changeSet` | the change set over every stack; its digest equals `digest` |

Secret values stay `[secret]` in the report and in every note. The change set is chant's [change set](https://intentius.io/chant/reference/change-set/). `reports.url` in `plywood.yml` keeps a copy of each run's report.
