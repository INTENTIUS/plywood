---
title: 'Separate environments'
description: 'A stack per environment, each environment with its own gate.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

A stack per environment is Pulumi's own pattern: `Pulumi.dev.yaml`, `Pulumi.prod.yaml`. plywood keeps it and adds a gate and approvers per environment:

```yaml
environments:
  dev: { stacks: ["*/dev"], gate: never }
  prod: { stacks: ["*/prod-*"], gate: always, role: platform }
```

Each environment can use its own cloud identity. [Scope state and cloud access](/plywood/guides/scope-state-access/).
