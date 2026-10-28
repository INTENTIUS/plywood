---
title: 'Configuration'
description: 'Each key of the config file, with its default value.'
needs: [plywood#5, chant#4541, chant#4550]
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
gate: on-destructive
approval: ledger
apply: { when: merge }
locks: { when: preview }
policy: { rego: policy/, packs: [policy/aws-guard] }
drift: { schedule: "0 6 * * *" }
```

| Key | Default | Meaning |
|---|---|---|
| `engine` | `pulumi` | `pulumi` or `plunge`; a `plunge+` backend URL also picks plunge |
| `backend` | the stack's own | the backend URL, per stack or for all |
| `stacks` | found by `init` | each stack as `project/stack`, with `dir`, `paths`, `gate` |
| `waves` | one per environment | lists of stacks, the first wave the canary; or `canary` and `after` |
| `gate` | `on-destructive` | `always`, `on-destructive` or `never` |
| `approval` | `ledger` | `ledger`, `sealed` or `pr-review` |
| `approval_rules` | none | role and quorum per stack glob |
| `apply.when` | `merge` | `merge`, or `pull-request` for `/plywood up` before merge |
| `apply.requires` | none | the conditions an open pull request meets before `/plywood up` updates it |
| `locks.when` | `preview` | `preview`, from the first preview, or `up`, from an update before merge or a `/plywood lock` comment |
| `locks.grain` | per engine | `resource` or `stack`; `resource` on plunge and `stack` on stock Pulumi when unset, and stock Pulumi refuses `resource` |
| `policy` | none | `rego` directory and CrossGuard `packs` |
| `drift` | off | `schedule`, a cron line, and `stacks`, the stacks the drift job reads |
| `respond.drift` | `issue` | `issue`, `pull-request`, `up` or `none`: the drift job's answer to a drifted stack |
| `identity` | none | `preview` and `up` identities |
| `review_stacks` | off | `template` and `name` |
| `control` | off | the control repo, as `host/owner/name` or a mapping with `repo` and `op` |
| `notify`, `telemetry`, `review`, `agent` | off | see their guides |
| `agent.token_env` | the job token | the secret, or on GitLab the protected variable, holding the token the agent's push job pushes with; a GitHub push with the job token starts no workflow, so name a user's or app's token here for the agent's commit to get a preview |
| `pulumi`, `plunge` | the image's | CLI version pins |

plywood turns each key into chant's workspace settings, so `plywood.yml` holds no chant key. A `ci.` key there is refused with the name of the plywood key that sets it.
