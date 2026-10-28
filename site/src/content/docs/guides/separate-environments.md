---
title: 'Separate environments'
description: 'A stack per environment, each environment in its own wave with its own gate.'
---

A stack per environment is Pulumi's own pattern: `Pulumi.dev.yaml`, `Pulumi.prod.yaml`. plywood keeps it. A stack's environment is its name before a region suffix, so `prod-east` is in `prod`. With no `waves` key, each environment is a wave, in dev, staging, prod order.

Give each environment its gate per stack, and its approvers per stack glob:

```yaml
stacks:
  shop/dev: { gate: never }
  shop/prod-east: { gate: always }
approval_rules:
  "*/prod-*": { role: platform, quorum: 2 }
```

A wave takes the strictest gate of its stacks. Each environment can use its own cloud identity. [Scope state and cloud access](/plywood/guides/scope-state-access/).
