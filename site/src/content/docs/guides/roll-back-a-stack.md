---
title: 'Roll a stack back to a release'
description: 'chant release cut records a stack''s program tree, and a rollback previews and updates that tree.'
---

plywood switches on chant's [releases](https://intentius.io/chant/cli/release/) for Pulumi stacks.

Cut a release after a good update. Without `--yes` the cut is a dry run that prints the plan:

```sh
npx chant release cut shop-2026-10-27 --yes
```

Roll every stack the release holds in an environment back to it:

```sh
npx plywood rollback --release shop-2026-10-27 --env prod
```

Roll one stack back to the release it ran before the current one, or to the release with a given digest:

```sh
npx plywood rollback shop/prod-east
npx plywood rollback shop/prod-east --digest sha256:9b2e...
```

The rollback previews the release's program against the stack, and the release gate waits for an approval of that preview. Approve its digest with the line plywood prints, then run the same command again to update the stack to the release's tree. `--dry-run` prints the preview and stops.
