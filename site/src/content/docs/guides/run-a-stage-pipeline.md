---
title: 'Run the environments as a stage pipeline'
description: 'Give each environment of promotion settings of its own, and let plywood write the pipeline chant runs.'
---

With `promotion` in `plywood.yml`, each environment is a stage. The merge updates the first environment's stacks and cuts a release, and `plywood promote` carries that release into each later environment through its gate. The keys on this page sit under `environments.<name>` beside `targets`, and each is off by default.

## Write the pipeline

`plywood ci` writes `.chant/pipeline.ts` from `plywood.yml`, with chant's pipeline workflows: the first stage's waves on merge, and a promote job per later stage. Every job of the pipeline runs in plywood's image with the engine install lines `plywood.yml` sets, as the waves do outside a pipeline. On GitHub and Forgejo it also writes `plywood-reject.yml`, which answers a `/plywood reject` comment. The pull request's plans job reads the first stage's spec from `.chant/op-waves/plywood-<stage>.spec.json`, which `plywood ci` writes too. The release cut on merge needs a clean tree, so it also adds `.chant/op-waves/*/` to `.gitignore`. The first stage's workflow takes over the merge, so `plywood ci` deletes the `pulumi-up` workflows it wrote before `promotion` was set. Commit the files with the workflows. The wave jobs read the committed file at the base commit, so an edited gate applies once its pull request merges.

`plywood init` and `plywood ci` write `release: { green: "forge-checks" }` into `chant.config.ts` when `promotion` is set. The release cut on merge then takes the merge commit's checks on the forge as its green gate: it waits while they run and cuts once they pass, so the repository needs no `ci/green` tag. The cut reads the checks with the pipeline job's forge token.

```sh
plywood ci           # writes .chant/pipeline.ts and the workflows
plywood ci --check   # exits 1 with a diff when .chant/pipeline.ts differs from what plywood.yml writes
```

Each environment runs the waves the merge runs today, over its own stacks. `environments` names every environment of `promotion`, with `{}` for one that sets nothing. `waves.canary` puts its stacks in a first wave of their own everywhere. Where more waves follow it and a soak there has a check, chant marks that wave as the canary. Its soak holds the waves after it.

```yaml
promotion: [dev, staging, prod]
waves:
  canary: [shop/dev]
environments:
  dev: {}
  staging:
    soak:
      duration: 30m
      checks:
        - kind: http
          url: https://staging.shop.example/health
    on_verify_fail: rollback
  prod:
    gate: always
    approval_rules:
      "*": { count: 2, proven: true }
    freeze:
      - { from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: year-end freeze }
    risk:
      approve_above: 0.6
      approval_rules:
        "*": { roles: [sre] }
risk:
  approve_above: 0.6
```

## Stage keys

| Key | Default | Sets |
|---|---|---|
| `environments.<name>.gate` | `gate` | when the stage's waves and a promote into it wait for an approval: `always`, `on-destructive` or `never` |
| `environments.<name>.approval` | `approval` | which approvals of the stage count: `ledger`, `sealed` or `pr-review`; `pr-review` for a stage with approval rules when neither it nor the top level sets `approval` |
| `environments.<name>.approval_rules` | `approval_rules` | the stage's own approval rules, in place of the top-level ones |
| `environments.<name>.forge_environment` | none | the forge deployment environment of the stage's jobs: a name, or a map with `name` and `url` |
| `environments.<name>.hold` | none | `true`, or a map with `reason`, `until` (an ISO 8601 time) and `description`: no release is promoted into the stage, and a promote exits 3 naming when it opens |
| `environments.<name>.freeze` | none | windows with `from`, `until` and `reason` in which no release is promoted into the stage |
| `environments.<name>.urgent.role` | none | the role from `.chant/trust.json` whose one sealed approval passes the stage's gate on `plywood promote --urgent` |
| `environments.<name>.pause_after_rollback` | `false` | a rollback of the stage pauses it, and `plywood resume <env>` opens it again |
| `environments.<name>.on_verify_fail` | `hold` | `hold` keeps the stage as updated when a verify or soak check fails; `rollback` requests the rollback to its previous release, which waits at gate `<stage>-rollback` for a person |
| `environments.<name>.failure_tolerance` | `0` | the failed runs a wave lets through: a whole number, or a share such as `10%` |
| `environments.<name>.after` | the stage before it | the stages a release updates in before this stage opens for it |
| `environments.<name>.queue` | none | `replace`: the stage takes one release at a time, and a newer release waiting replaces an older one |
| `environments.<name>.soak.duration` | none | how long the soak checks keep passing after the stage's last update before a release moves on; `0` waits for the checks alone |
| `environments.<name>.soak.checks[]` | none | each check's `kind` (`http`, `prometheus`, `cloudwatch-alarm`, `command`, `health`, `drift`, `apply`, `policy`) with that kind's settings beside it, and `on_fail`: `restart` (the default) or `hold` |
| `environments.<name>.soak.overrides[]` | none | `members`, stack names or globs, with their own `duration` and `checks` |
| `environments.<name>.risk.approve_above` | `risk.approve_above` | the risk score from 0 to 1 above which a promote into the stage takes the stage's risk rules |
| `environments.<name>.risk.approval_rules` | none | the approval rules the stage's gate adds over the score, such as `{ count: 2 }` or `{ roles: [sre] }` |
| `environments.<name>.replan_dependents` | `replan_dependents` | stacks whose dependents are previewed again when an output they read changes after an update in this stage |
| `environments.<name>.publish.<artifact>` | none | a release artifact the stage publishes once it updated: `{ member, output }`, or `{ secret }` naming where a secret is kept |
| `environments.<name>.reads.<variable>` | none | an artifact of an earlier stage that the stage's update gets in a variable: `{ stage, artifact }` |
| `environments.<name>.agent_steps.<step>` | none | a model's reading of the release the stage takes, with `prompt`, `schema`, `reads`, `command`, `key_secret`, `timeout`, `max_runs` and `max_cost_usd`; its answer approves and applies nothing |
| `environments.<name>.config.<variable>` | none | a plain value the stage's jobs get as a variable |
| `environments.<name>.secrets.<variable>` | none | a secret the stage's jobs get as a variable: a forge secret's name, or a map with one of `forge_secret`, `aws_secrets_manager` (with `json_key` and `region`), `gcp_secret_manager`, `azure_key_vault` |
| `environments.<name>.imports` | none | the `config_sets` the stage's set takes first, in order |
| `config_sets.<set>` | none | a shared set of `config`, `secrets` and `imports` that environments import |
| `risk.approve_above` | none | the score above which a change needs an approval of its own digest; the preview note shows the score and its reasons |
| `risk.questions[]` | none | questions the review agent answers from 0 to 1, each with `id`, `text`, `weight` and its own `approve_above` |
| `replan_dependents` | none | for every stage, and for the waves on merge without `promotion` |
| `release.cut` | `true` | the merge cuts a release once the first stage updated |
| `release.label` | `auto` | the release's label, or `auto` for the next version |
| `recheck.schedule` | none | a five-field cron line on which a promotion a soak holds is tried again |
| `control.release` | `false` | the `plywood-applied` dispatch carries the release digest, so the control repo reads that release's artifacts |
| `agent.verify-failed` | off | `true`, or a map with `window` and `relay_key_secret`: an agent opens a pull request when a stage's verify or soak check fails, within `agent.max_runs` |

`approval_rules` takes `count` and `roles` (the spellings `quorum` and `role` keep working), `proven: true` to count only approvers a seal or a review proves, and `name`. A label mapped to `{ all: ... }` or `{ any: ... }` is a group of rules, met when every rule in it is met or when one is, nested up to three deep:

```yaml
approval_rules:
  release:
    any:
      "*": { count: 2, proven: true, name: two-approvers }
      "shop/*": { roles: [release-manager], name: release-manager }
```

A risk score adds approvals to the ones a change's gate asks for. A soak or a hold keeps a release waiting.

Every approval rule leaves the change's author out. A rule therefore counts the approvers that a seal or a review proves. With approval rules and no `approval` key, the merge's waves take `pr-review`, as each environment does. The merged pull request's reviews prove its reviewers, and a sealed `plywood approve --sign` counts as well. A repository with no signers in `.chant/allowed_signers` then passes `plywood check`, and each change waits for a reviewer other than its author. Without rules the merge's waves keep taking the pull request's own approval as their source. An `approval` key on the top level or on an environment picks the source for that scope. Under `ledger` the approvers' keys go in the signers file and each approval uses `--sign`.

## The preview note

The preview note shows the change's risk score with each reason, and each soak the change passes through once it merges: the stage's soak with the stages it holds, and the canary wave's soak with the waves it holds. `plywood check` prints chant's findings on the approval rules, such as a rule that needs a proven approver when nothing in the repository can prove one, and fails when chant refuses one.

## Hold, pause and reject

```sh
plywood pause prod --reason "incident 412"            # a promote into prod exits 3, and its release waits
plywood resume prod --reason "incident 412 closed"     # the newest release that waited enters
plywood reject plywood prod --plan <digest> --reason "fails the load test"
plywood promote --to prod --release v1.4.2 --urgent --reason "security fix"
```

A comment on the pull request does the same: `/plywood reject [--stage <stage>] <reason>`. chant records it as the commenter where the stage counts their forge identity (`ledger`, `pr-review`), and on a `sealed` stage, or a rule with `roles` or `proven`, replies with the `plywood reject` line to run with `--sign`. On GitLab the note-commands job answers it.

`plywood reject` turns down the release a stage's gate waits on; a promote of that release into the stage exits 8 and names who rejected it. `--urgent` passes the stage's gate on one sealed approval from its `urgent.role`, once the release has updated in every stage before it.
