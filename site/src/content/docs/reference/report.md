---
title: 'The report'
description: 'The JSON each stage writes, with its schema version.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

Each stage writes `.plywood/report.json`, schema `plywood.report/v1`.

| Field | Holds |
|---|---|
| `stage` | `check`, `preview`, `up` or `drift` |
| `stacks` | per stack: entries by URN, op, type and changed properties |
| `digest` | the change set's digest, and one per stack |
| `waves` | each wave's stacks, gate and digest |
| `policy` | Rego and CrossGuard results |
| `tips` | tip ids, see [Tips](/plywood/reference/tips/) |

Secret values stay `[secret]` in the report and in every note. The change set inside the report is chant's [change set](https://intentius.io/chant/reference/change-set/).
