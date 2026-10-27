---
title: 'One note for every stack'
description: 'A change that reaches four stacks gives one note with a section per stack and one approval command.'
needs: [plywood#11, plywood#6, chant#4541, chant#4550]
draft: true
---

Make the same change in the other three stack files, `Pulumi.staging.yaml`, `Pulumi.prod-east.yaml` and `Pulumi.prod-west.yaml`, and push.

The preview job previews all four stacks and replaces the note in place:

```text
plywood preview: 4 stacks, 4 to update

Same change on 4 stacks:
  ~ aws:sqs/queue:Queue events   messageRetentionSeconds 3600 => 7200
  shop/dev  shop/staging  shop/prod-east  shop/prod-west

Approve: plywood approve pr-1 --plan sha256:71d2...
```

Stacks that take the same change share one diff. Each stack's full preview sits collapsed below it.

The digest changed with the push, so the command from the first note no longer matches. One approval of the new digest covers all four stacks. [Why previews are grouped](/plywood/concepts/why-previews-are-grouped/).
