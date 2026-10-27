---
title: 'Notify a chat channel'
description: 'A chat channel or a signed webhook hears about waiting waves and failed updates.'
needs: [plywood#1]
draft: true
---

plywood switches on chant's [notify](https://intentius.io/chant/guide/notify/).

```yaml
notify:
  slack: { webhook: SLACK_WEBHOOK_URL }
  on: [wave-waiting, up-failed, drift]
```

Each event is a signed `chant.notify/v1` message. plywood writes the summary line, such as "shop/prod-east waits for an approval of sha256:e41b...".
