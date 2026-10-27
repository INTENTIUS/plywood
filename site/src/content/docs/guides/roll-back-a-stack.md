---
title: 'Roll a stack back to a release'
description: 'chant release cut records a stack''s program tree, and a rollback previews and updates that tree.'
needs: [plywood#16, chant#4541, chant#4542, chant#4550]
draft: true
---

plywood switches on chant's [releases](https://intentius.io/chant/cli/release/) for Pulumi stacks.

Cut a release after a good update:

```sh
npx chant release cut shop-2026-10-27
```

Roll a stack back to it:

```sh
npx plywood rollback shop/prod-east --release shop-2026-10-27
```

The rollback previews the release's program against the stack. The preview waits for an approval like any other, and `up` runs the release's tree.
