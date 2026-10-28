---
title: 'One note for every stack'
description: 'A change that reaches four stacks gives one note with a section per stack and one approval command.'
---

Make the same change in the other three stack files, `Pulumi.staging.yaml`, `Pulumi.prod-us.yaml` and `Pulumi.prod-eu.yaml`, and push.

The preview job previews all four stacks and replaces the note in place. The table has a row per stack, and the summary puts the stacks that take the same change in one group:

```text
4 stacks: 1 group, 0 destroys or replacements.

~ aws:sqs/queue:Queue events: messageRetentionSeconds

Stacks: shop/dev, shop/prod-eu, shop/prod-us, shop/staging
```

Each stack's full preview sits collapsed below it.

The digest changed with the push, so the line from the first note no longer matches. One approval of the new digest covers all four stacks:

```text
plywood approve up --plan jcs1-sha256:71d2...
```

[Why previews are grouped](/plywood/concepts/why-previews-are-grouped/).
