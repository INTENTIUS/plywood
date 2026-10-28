---
title: 'Query with SQL'
description: 'plywood query answers questions such as which updates ran this week, over the ledger.'
---

```sh
npx plywood query "SELECT member, wave, ended, status FROM runs WHERE op = 'pulumi-up' AND started > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')"
```

`plywood query` runs [chant query](https://intentius.io/chant/cli/query/), SQLite over the ledger's tables, which its page lists. Only a `SELECT`, `WITH` or `VALUES` statement runs. On plunge the `resources` table's `engine_ownership` and `engine_owned_by` columns hold plunge's ownership verdict and the stack that owns each resource.
