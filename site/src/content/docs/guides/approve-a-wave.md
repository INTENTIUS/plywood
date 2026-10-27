---
title: 'Approve a wave'
description: 'plywood approve records an approval of one preview digest, and the wave''s next job updates the stacks it covers.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

A waiting wave posts its gate and digest on the merged pull request:

```text
wave-2 waits: shop/staging, sha256:0a6f...
```

Read the preview in the note, then approve that digest:

```sh
npx plywood approve wave-2 --plan sha256:0a6f...
```

plywood records it as a row in the [chant workspace ledger](https://intentius.io/chant/cli/ledger/), and chant's [gate decision](https://intentius.io/chant/guide/decision-points/) reads it. The wave's next job then updates the stacks. Each approval counts once, for that digest only.

## Signed approvals

With `approval: sealed`, add `--sign`. The approval then needs an SSH key listed in `.chant/allowed_signers`, and CI jobs hold no such key.
