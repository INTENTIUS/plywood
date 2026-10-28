---
title: 'Preview a few resources'
description: 'Pass URNs as targets to see the preview of those resources alone.'
needs: [plywood#28]
draft: true
---

Name one or more URNs on the preview:

```sh
npx plywood preview shop/prod --target urn:pulumi:prod::shop::aws:sqs/queue:Queue::events
```

Each `--target` goes to `pulumi preview --target` for every stack the pull request reaches, or only for the stack you name. Repeat it for more resources. The note shows the narrowed preview, and its digest covers the targets, so an approval of it covers no other preview.

The update on merge still previews whole stacks, so an approval of a narrowed preview does not let it through. Use a targeted preview to look at a few resources in a large stack, and approve the full preview to update. A stack whose step cannot narrow to resources is refused by name, and nothing is previewed.

Targeting is chant's [resource targeting](https://intentius.io/chant/guide/resource-targeting/).
