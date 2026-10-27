---
title: 'A preview that changed after review'
description: 'Push again after an approval, and plywood refuses the old approval and names the change.'
needs: [plywood#1, chant#4541, chant#4553, chant#4550]
draft: true
---

Open a new pull request that sets `corpus:workerCount: "4"` on `dev`, and approve its preview.

Before you merge, push one more commit that also sets `corpus:workerCount: "5"`. The preview job runs again and the note now reads:

```text
plywood preview: 1 stack, 2 to create

The approval of sha256:58aa... no longer covers this preview.
Changed since it: + aws:sqs/queue:Queue worker-4

Approve: plywood approve pr-2 --plan sha256:c370...
```

Merge anyway, and the canary wave refuses to update:

```text
plywood up: refused, preview moved
approved sha256:58aa..., previewed sha256:c370...
```

Nothing reaches floci. Approve the new digest and the wave runs. [Fix a refused wave](/plywood/guides/fix-a-refused-wave/).
