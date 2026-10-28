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

Roll every stack the release holds in an environment back to it:

```sh
npx plywood rollback --release shop-2026-10-27 --env prod
```

Roll one stack back to the release it ran before the current one:

```sh
npx plywood rollback shop/prod-east
```

The rollback previews the release's program against the stack, and the release gate waits for an approval of that preview. After the approval, the same command again updates the stack to the release's tree. `--dry-run` prints the preview and stops.
