---
title: 'Preview and update a few resources'
description: 'Pass URNs as targets, and the approval covers exactly that narrowed preview.'
needs: [TBD-pr-plan-targets]
draft: true
---

Name one or more URNs on the preview:

```sh
npx plywood preview shop/prod --target urn:pulumi:prod::shop::aws:sqs/queue:Queue::events
```

The preview passes `--target` to Pulumi, and the targets join the preview digest. An approval of that digest covers the narrowed preview only, and `up` runs with the same targets. Targeting is chant's [resource targeting](https://intentius.io/chant/guide/resource-targeting/).
