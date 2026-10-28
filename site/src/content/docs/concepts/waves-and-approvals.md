---
title: 'Waves and approvals'
description: 'The way stacks form waves, and the digest each gate binds.'
---

`plywood.yml` lists waves in order. The first is the canary. `plywood ci` writes them to `.chant/op-waves/pulumi-up.spec.json`, which the update jobs read at base. After merge, plywood switches on chant's [gated waves](https://intentius.io/chant/guide/op-waves/):

1. Each wave previews its stacks against the merged program.
2. The gate compares that preview's digest with the approved one.
3. A match updates the wave, and the approval is spent.
4. A mismatch refuses the wave and names both digests.

The pull request's approval carries over to each wave whose plans it covers. Any other wave waits at its own gate. Its job prints the `plywood approve wave-<k>` line for its digest. `gate` decides which waves ask at all. A failed stack holds only the stacks that depend on it, through chant's [failed member blocks](https://intentius.io/chant/guide/failed-member-blocks/).
