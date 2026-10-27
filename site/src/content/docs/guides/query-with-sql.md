---
title: 'Query with SQL'
description: 'chant query answers questions such as which stacks changed in prod this week, over the ledger.'
needs: [plywood#1]
draft: true
---

```sh
npx chant query "SELECT member, ended FROM runs WHERE kind = 'up' AND member LIKE 'shop/prod-%' AND started > now() - INTERVAL 7 DAY"
```

[chant query](https://intentius.io/chant/cli/query/) runs SQL over the ledger's tables, which its page lists. On plunge, the `engine_ownership` columns carry each resource's owning stack.
