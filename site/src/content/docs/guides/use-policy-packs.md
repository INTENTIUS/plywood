---
title: 'Use your CrossGuard policy packs'
description: 'The preview job runs your CrossGuard policy packs, and their violations go into the note and the gate.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

CrossGuard packs run where Pulumi runs them, in the preview:

```yaml
policy:
  packs: [policy/aws-guard]
```

The preview job runs `pulumi preview --policy-pack policy/aws-guard`. Each violation shows in the note under its stack. A mandatory violation denies the preview at the gate, and an advisory one stays a note line.

On Pulumi Cloud, packs your organisation enforces keep running there too. Rego rules and CrossGuard packs sit side by side in one gate, chant's [gate policy](https://intentius.io/chant/guide/gate-policy/).
