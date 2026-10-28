---
title: 'Find drift'
description: 'Change a queue by hand on floci; the scheduled drift job opens one issue naming the URN and the attribute.'
---

Turn on the drift check. Add a schedule to `plywood.yml` and write the workflow again:

```yaml
drift:
  schedule: "0 6 * * *"
```

```sh
npx plywood ci --forge forgejo
git add -A && git commit -m "drift check" && git push origin main
```

`plywood ci` writes one scheduled drift job per stack.

Change the dev queue's retention behind Pulumi's back, from the clone with the bench's settings in your shell:

```sh
url=$(pulumi stack output eventsQueueUrl --stack dev)
aws sqs set-queue-attributes --queue-url "$url" --attributes MessageRetentionPeriod=60
```

Run `shop/dev`'s drift job from Forgejo's Actions page in place of waiting for its schedule. On a stock engine it runs `pulumi refresh --preview-only` against each resource of the stack's last update, and opens one issue, `plywood: shop/dev has drifted`, with a row for the queue:

```text
| `urn:pulumi:dev::shop::aws:sqs/queue:Queue::events` | drifted | `messageRetentionSeconds` |
```

The job exits with the `drift` code. The next drift run leaves the issue as it is while the finding stays the same, edits it when the finding changes, and closes it once the stack matches again. [Turn on drift checks](/plywood/guides/turn-on-drift-checks/).
