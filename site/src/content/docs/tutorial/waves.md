---
title: 'Canary, then waves'
description: 'The dev stack updates first, then staging, then both prod stacks, each wave under the approval of the pull request''s preview.'
---

`plywood init` put the stacks in three waves in `.chant/op-waves/pulumi-up.spec.json`:

| Wave | Gate | Stacks |
|---|---|---|
| 1, `dev` | `wave-1` | `shop/dev`, the canary |
| 2, `staging` | `wave-2` | `shop/staging` |
| 3, `prod` | `wave-3` | `shop/prod-us`, `shop/prod-eu` |

Approve the pull request's preview as `tutor`, then merge:

```sh
npx plywood approve up --plan jcs1-sha256:71d2...
```

`plywood approve up` finds the pull request from the digest. After the merge, the waves job runs the waves in order. Each wave previews its stacks on the merged commit, and when the approved preview covers those plans the wave updates under it. The job log says so for each wave:

```text
wave 1 (dev) applies under the pull request's approval of jcs1-sha256:71d2... at up, which covers its plans
```

A wave whose plans the approval does not cover waits at its own gate, and the job prints the line that approves it, such as `plywood approve wave-2 --plan <digest>`. A later wave never starts before the one ahead of it finishes.

Check the result on floci, from the clone with the bench's settings in your shell:

```sh
url=$(pulumi stack output eventsQueueUrl --stack prod-us)
aws sqs get-queue-attributes --queue-url "$url" --attribute-names MessageRetentionPeriod
```
