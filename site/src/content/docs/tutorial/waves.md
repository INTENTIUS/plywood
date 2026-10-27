---
title: 'Canary, then waves'
description: 'The dev stack updates first, and the prod stacks wait behind their own gate for an approval of their preview digest.'
needs: [plywood#11, plywood#7, chant#4541, chant#4550]
draft: true
---

The example's `plywood.yml` puts the stacks in three waves:

```yaml
waves:
  - [shop/dev]
  - [shop/staging]
  - [shop/prod-east, shop/prod-west]
gate: always
```

Approve the pull request's preview as `tutor`, then merge:

```sh
npx plywood approve pr-1 --plan sha256:71d2...
```

After the merge, the waves job runs:

1. `shop/dev`, the canary, updates.
2. `shop/staging` waits behind gate `wave-2` and posts its digest on the merged pull request.
3. You approve wave 2, and staging updates.
4. Both prod stacks wait behind `wave-3`, and one approval releases both.

```sh
npx plywood approve wave-2 --plan sha256:0a6f...
npx plywood approve wave-3 --plan sha256:e41b...
```

Check the result on floci:

```sh
aws --endpoint-url http://localhost:4566 sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/plc-prod-east-events \
  --attribute-names MessageRetentionPeriod
```
