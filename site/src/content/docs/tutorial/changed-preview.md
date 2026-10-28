---
title: 'A preview that changed after review'
description: 'Push again after an approval, and the old approval no longer covers the waves.'
---

Open a new pull request that sets `corpus:workerCount: "4"` on `dev`, and approve its preview. The program's default is three worker queues, so the preview creates `worker-3`.

Before you merge, push one more commit that sets `corpus:workerCount: "5"`. The preview job runs again, and the note now shows two queues to create and a new digest. The approval you gave names the old digest, so it covers neither the new preview nor the merge.

Merge anyway. The canary wave previews `shop/dev` on the merged commit and finds plans the approval does not cover, so it stops before anything changes:

```text
wave 1 (dev): the pull request's approval does not cover it (no approval at up covers it), so it waits at its own gate wave-1
```

Nothing reaches floci. Read the new preview, and if it is right, approve its digest with the line the job printed (`plywood approve wave-1 --plan <digest>`). Then `npx plywood resume` starts the wave jobs the approval cleared. [Fix a refused wave](/plywood/guides/fix-a-refused-wave/).
