---
title: 'Find drift'
description: 'Change a queue by hand on floci; the scheduled drift job opens one issue naming the URN and the attribute.'
needs: [plywood#11, plywood#8]
draft: true
---

Change the dev queue's retention behind Pulumi's back:

```sh
aws --endpoint-url http://localhost:4566 sqs set-queue-attributes \
  --queue-url http://localhost:4566/000000000000/plc-dev-events \
  --attributes MessageRetentionPeriod=60
```

Run the drift job now in place of waiting for its schedule:

```sh
npx plywood drift --stack shop/dev
```

On a stock engine the job runs `pulumi refresh --preview-only`. It opens one issue in Forgejo:

```text
Drift on shop/dev
urn:pulumi:dev::corpus-aws-ts::aws:sqs/queue:Queue::events
  messageRetentionSeconds  program 7200, live 60
```

The next drift run updates the same issue, and closes it once the stack matches again. [Turn on drift checks](/plywood/guides/turn-on-drift-checks/).
