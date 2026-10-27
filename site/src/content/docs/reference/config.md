---
title: 'Configuration'
description: 'Each key of the config file, with its default value.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

```yaml
engine: pulumi
stacks:
  shop/dev: { dir: infra }
  shop/prod-east: { dir: infra }
waves:
  - [shop/dev]
  - [shop/prod-east]
gate: destroy
approval: ledger
locks: resource
policy: { rego: policy/, packs: [policy/aws-guard] }
drift: { schedule: "0 6 * * *" }
```

| Key | Default | Meaning |
|---|---|---|
| `engine` | `pulumi` | `pulumi` or `plunge`; a `plunge+` backend URL also picks plunge |
| `backend` | the stack's own | the backend URL, per stack or for all |
| `stacks` | found by `init` | each stack as `project/stack`, with `dir`, `paths`, `gate` |
| `waves` | one per environment | lists of stacks; the first wave is the canary |
| `gate` | `destroy` | `always`, `destroy` or `never` |
| `approval` | `ledger` | `ledger`, `sealed` or `pr-review` |
| `approvals` | none | role and quorum per stack glob |
| `locks` | `resource` | `resource` or `stack` |
| `policy` | none | `rego` directory and CrossGuard `packs` |
| `drift` | off | `schedule`, a cron line |
| `identity` | none | `preview` and `up` identities |
| `ci.workflow` | `up-on-merge` | or `up-before-merge` |
| `reviewStacks` | off | `template` and `name` |
| `notify`, `telemetry`, `review`, `agent`, `control` | off | see their guides |
| `pulumi`, `plunge` | the image's | CLI version pins |
