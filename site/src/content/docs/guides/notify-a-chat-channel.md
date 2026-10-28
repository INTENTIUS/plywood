---
title: 'Notify a chat channel'
description: 'A chat channel or a signed webhook hears about waiting waves and refused or failed updates, and about drift.'
---

plywood switches on chant's [notify](https://intentius.io/chant/guide/notify/).

```yaml
notify:
  slack: { webhook: SLACK_WEBHOOK_URL }
  on: [wave-waiting, up-refused, up-failed, drift]
```

Each value names a variable; the URL itself never goes in `plywood.yml`. `teams: { webhook: ... }` does the same for Microsoft Teams, and `webhook: { url: ..., key: ... }` sends to any endpoint, each `chant.notify/v1` event signed with the key under `x-plywood-*` headers. `on` lists the events to send, all four when left out. Every event carries `source: plywood` and a summary line in plywood's words.

`plywood drift` sends one `drift` event per run that finds drift. The event names the drifted stacks and carries the run's fingerprint. A run whose finding matches the last one sends nothing. The drift issues hold the last finding: with `--forge`, a run sends again only once a stack's finding changes. A run that keeps no issues sends on every drift. The scheduled drift job maps each notify variable from the secret of the same name, as the waves workflow does.

Set `relay` to the variable holding a relay key, and a waiting wave's Slack message gets Approve and Decline buttons. Its Teams card gets a reply that approves. `plywood notify relay` receives them and records the approval on the ledger.
