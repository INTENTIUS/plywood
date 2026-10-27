---
title: 'Waves and approvals'
description: 'The way stacks form waves, and the digest each gate binds.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

`plywood.yml` lists waves in order. The first is the canary. After merge, plywood switches on chant's [gated waves](https://intentius.io/chant/guide/op-waves/):

1. Each wave previews its stacks against the merged program.
2. The gate compares that preview's digest with the approved one.
3. A match updates the wave, and the approval is spent.
4. A mismatch refuses the wave and names both digests.

The pull request's approval covers the first wave. Each later wave posts its own digest and waits for its own approval, unless `gate` lets it through. A failed stack holds only the stacks that depend on it, through chant's [failed member blocks](https://intentius.io/chant/guide/failed-member-blocks/).
