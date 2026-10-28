---
title: 'See the approval before merge'
description: 'plywood/approval on the pull request says whether its approval covers every wave.'
needs: [chant#4630]
draft: true
---

The pull request carries a `plywood/approval` status. It is `pending` while some wave's plans at the head have no approval of the pull request's preview covering them. Once one approval covers them all it is `success` and names the approver. A branch rule that requires the status keeps the merge closed while it is `pending`.

`plywood ci` writes the plans workflow that posts it (on GitLab, the `record-plans` and `approval-status` jobs). Each push records the head's plans, and the status is read again on each push and review.

An approval on the ledger starts no run on the forge, so `plywood approve up` posts the status again itself on the open pull requests into the target branch:

```sh
npx plywood approve up --plan jcs1-sha256:71d2... --forge github --branch main
```

`--forge` falls back to `forge.kind` in `plywood.yml`, then to the CI job's forge. `--branch` falls back to the job's target branch. Posting needs a forge token in the shell. When plywood cannot tell the forge or the branch, or the post fails, the approval still stands: plywood prints the `plywood run wave ... --approval-status --open` line to post it by hand, and the status moves at the next push or review anyway.

An approval of another digest leaves the status `pending`. So does a push after the approval that changes a wave's plans.
