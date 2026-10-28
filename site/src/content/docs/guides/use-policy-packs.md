---
title: 'Use your CrossGuard policy packs'
description: 'The preview job runs your CrossGuard policy packs, and their violations go into the note and the gate.'
---

CrossGuard packs run where Pulumi runs them:

```yaml
policy:
  packs:
    - policy/aws-guard
    - { dir: policy/tags, config: policy/tags/config.json }
```

Each stack's preview runs `pulumi preview` with `--policy-pack` for each pack, and its update runs `pulumi up` with the same packs. plywood reads the packs from the base branch. A pull request that edits a pack is judged by the base's copy. Each violation shows in the note under its stack. A mandatory violation denies the preview at the gate, and an advisory one stays a note line. A denied CrossGuard rule is `crossguard.<pack>.<policy>`, the id `plywood override --rule` takes.

On Pulumi Cloud, packs your organisation enforces keep running there too. Rego rules and CrossGuard packs sit side by side in one gate, chant's [gate policy](https://intentius.io/chant/guide/gate-policy/).
