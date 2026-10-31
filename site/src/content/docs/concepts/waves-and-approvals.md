---
title: 'Waves and approvals'
description: 'The way stacks form waves, and the digest each gate binds.'
---

`plywood.yml` lists waves in order. The first is the canary. `plywood ci` writes them to `.chant/op-waves/pulumi-up.spec.json`, which the update jobs read at base. After merge, plywood switches on chant's [gated waves](https://intentius.io/chant/guide/op-waves/):

1. Each wave previews its stacks against the merged program.
2. The gate compares that preview's digest with the approved one.
3. A match updates the wave, and the approval is spent.
4. A mismatch refuses the wave and names both digests.

With `approvals.preview` in the spec, which `plywood init` sets, a merged wave also compares its fresh digest with the one `plywood run wave --record-plans` recorded for the pull request that produced the merge commit. The comparison runs under every gate policy, so a change that `gate: on-destructive` would let through unasked is checked too. A match goes on under the wave's gate as before. A different digest refuses the wave with exit 4 and applies nothing, and so does a merge with no pull request or a wave whose plans were never recorded. The wave job asks the forge for the merged pull request, so it needs a token that can read pull requests. On GitHub that is `pull-requests: read`. Forgejo's job token has it. GitLab needs a `CHANT_FORGE_TOKEN` CI/CD variable holding a project access token with `read_api`. A person who has read the new plans can approve their digest, and the wave then applies them.

The pull request's approval carries over to each wave whose plans it covers. Any other wave waits at its own gate. Its job prints the `plywood approve wave-<k>` line for its digest. `gate` decides which waves ask at all. A failed stack holds only the stacks that depend on it, through chant's [failed member blocks](https://intentius.io/chant/guide/failed-member-blocks/).
