---
title: 'Read the audit trail'
description: 'Every approval and update is a row in the chant workspace ledger.'
needs: [plywood#20, chant#4541, chant#4550]
draft: true
---

```sh
npx plywood audit --since 7d
npx plywood audit --stack shop/prod-east --json
```

`plywood audit` reads the [chant workspace ledger](https://intentius.io/chant/cli/ledger/), which lives on your repository's `chant/lifecycle` branch. Each row names the actor and the time, and it carries the gate and the digest. `chant ledger` reads one table with typed filters:

```sh
npx chant ledger gates --where kind=resolution --since 7d
```
