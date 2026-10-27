---
title: 'Your first pull request'
description: 'Change a queue setting and read the preview note on the pull request.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

Clone the example and make a branch:

```sh
git clone http://localhost:3000/tutor/shop && cd shop
git switch -c longer-retention
```

In `Pulumi.dev.yaml`, raise the event queue's retention:

```yaml
corpus:eventsRetentionSeconds: "7200"
```

Commit, push and open a pull request in Forgejo. The preview job starts within a few seconds.

## The note

```text
plywood preview: 1 stack, 1 to update

shop/dev   ~ aws:sqs/queue:Queue events   messageRetentionSeconds 3600 => 7200

Approve: plywood approve pr-1 --plan sha256:9c0e...
```

The `plywood/preview` status reads "waiting for approval". The digest in the approval command covers this preview and no other.

Leave the pull request open; the next page adds three more stacks to it.
