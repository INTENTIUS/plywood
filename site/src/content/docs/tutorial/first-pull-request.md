---
title: 'Your first pull request'
description: 'Change a queue setting and read the preview note on the pull request.'
---

Clone the example, with the bench's settings in your shell:

```sh
source <plywood checkout>/stack/.state/tutorial.env
export PULUMI_BACKEND_URL="$PLYWOOD_TUTORIAL_S3_BACKEND"
git clone http://127.0.0.1:3390/tutor/shop && cd shop
```

## Set up plywood

The example has no workflow yet. Add plywood and let `init` write it, with every wave that changes something waiting for an approval:

```sh
npm i -D @intentius/plywood
npx plywood init --preset approve-all --forge forgejo --yes
git add -A && git commit -m "plywood" && git push origin main
```

`init` prints the waves it found, one per environment: `dev`, the canary, then `staging`, then `prod` with `shop/prod-us` and `shop/prod-eu`. It writes them to `.chant/op-waves/pulumi-up.spec.json`, beside `plywood.yml` and `.forgejo/workflows/`.

## A change

```sh
git switch -c longer-retention
```

In `Pulumi.dev.yaml`, raise the event queue's retention (the program's default is 3600):

```yaml
  corpus:eventsRetentionSeconds: "7200"
```

Commit, push and open a pull request in Forgejo. The preview job starts within a few seconds.

## The note

The job posts one note on the pull request. The note's table has a row for `shop/dev` with one update. The summary below it shows the change:

```text
~ aws:sqs/queue:Queue events: messageRetentionSeconds
```

The note ends with the plan's digest and the line that approves it:

```text
plywood approve up --plan jcs1-sha256:9c0e...
```

The stack's `plywood/preview/shop/dev` status waits for that approval. The digest covers this preview and no other.

Leave the pull request open; the next page adds three more stacks to it.
