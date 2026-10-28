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

Set `relay` to the variable holding a relay key, and a waiting wave's Slack message gets Approve and Decline buttons. Its Teams card gets a reply that approves. `plywood notify relay` receives them and records the approval on the ledger.
