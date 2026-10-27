---
title: 'Update a stack before it merges'
description: 'Opt in with ci.workflow, then a /plywood up comment updates the approved preview from the pull request.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

plywood switches on chant's [apply before merge](https://intentius.io/chant/guide/apply-before-merge/).

```yaml
ci:
  workflow: up-before-merge
```

Approve the preview, then comment:

```text
/plywood up
```

The waves run from the pull request in order, each behind its gate. Merge once the last wave is done. Name a wave to run one at a time:

```text
/plywood up wave-2
```

The pull request holds its locks for its whole life, and lets go of them when it merges.
