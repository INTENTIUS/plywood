---
title: 'Read the audit trail'
description: 'Every approval and update is a row in the chant workspace ledger.'
---

```sh
npx plywood audit --since 7d
npx plywood audit updates --stack shop/prod-east --json
npx plywood audit approvals --where gate=wave-2
```

`plywood audit` reads one table of the [chant workspace ledger](https://intentius.io/chant/cli/ledger/), which lives on your repository's `chant/lifecycle` branch:

| Table | Rows |
|---|---|
| `approvals` (the default) | gates waiting and approvals given, with the actor, the time and the plan digest |
| `updates` | updates under an approval, and how each ended |
| `runs` | wave run records |
| `review-stacks` | review stacks made and removed |

Any other chant ledger table name passes as written.

The ledger keeps rows per project, so `--stack shop/prod-east` reads the rows of the `shop` project. `--json` prints the rows exactly as `chant ledger` prints them, and `plywood query "<sql>"` runs SQL over the same tables.
