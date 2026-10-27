---
title: 'Keep the stack export current'
description: 'Each update stores the stack export under refs/chant/snapshots for the graph to read.'
needs: [plywood#8, chant#4541, chant#4519, chant#4550]
draft: true
---

After each `up`, the update writes the stack's export as the member's snapshot under `refs/chant/snapshots`. The working tree stays clean.

The graph and behold read the snapshot, and so does drift, so none of them needs a backend login. This reads one by hand:

```sh
git fetch origin 'refs/chant/snapshots/*:refs/chant/snapshots/*'
npx chant workspace graph --member shop/prod-east
```

Secrets in the export stay ciphertext.
