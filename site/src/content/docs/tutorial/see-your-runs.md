---
title: 'See your runs'
description: 'Read the tutorial''s runs and approvals with plywood audit and plywood query.'
---

Every approval and update in the tutorial left a row in the chant workspace ledger of `tutor/shop`, on its `chant/lifecycle` branch. plywood keeps no copy of any row.

```sh
npx plywood audit --since 1h
```

With no table named, `audit` reads the approvals table. Each gate that waits and each approval is a row naming its actor, its time and its plan digest. `updates`, `runs` and `review-stacks` read the other tables, and `--stack` and `--where` narrow them:

```sh
npx plywood audit updates --stack shop/prod-us
npx plywood audit approvals --where gate=wave-1
```

`plywood audit --json` prints exactly the rows [chant ledger](https://intentius.io/chant/cli/ledger/) prints. The same rows answer SQL:

```sh
npx plywood query "SELECT * FROM gates"
```
