---
title: 'Keep the stack export current'
description: 'Each update stores the stack export under refs/chant/snapshots for the graph to read.'
needs: [chant#4519]
draft: true
---

After each `up`, chant's pulumi apply writes the stack's export as the member's snapshot under `refs/chant/snapshots`. The working tree stays clean.

The graph and behold read the snapshot, and so does drift, so none of them needs a backend login. Each Pulumi project is one workspace member. This reads the `shop` project's by hand:

```sh
git fetch origin 'refs/chant/snapshots/*:refs/chant/snapshots/*'
npx chant workspace graph --member shop
```

The apply strips secret values from the export before it writes the snapshot.
