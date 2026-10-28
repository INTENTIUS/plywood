---
title: 'Configuration'
description: 'Each key of the config file, with its default value.'
---

plywood reads the nearest `plywood.yml` (or `plywood.yaml`) in the working directory or a directory above it, stopping at the repository root. `plywood config check` checks it and prints the settings in force, and `plywood.schema.json` in the package is its JSON schema.

```yaml
stacks:
  shop/dev: { dir: infra }
  shop/prod-us: { dir: infra }
gate: on-destructive
apply: { when: merge }
locks: { when: preview }
policy: { rego: policy/, packs: [policy/aws-guard] }
drift: { schedule: "0 6 * * *" }
```

| Key | Default | Meaning |
|---|---|---|
| `stacks` | found by `init` | each stack as `project/stack`, with `dir`, `paths`, `gate` and `backend` |
| `waves` | one wave per environment, dev before staging before prod | a list of waves, each a list of stacks, the first wave the canary; or a mapping with `canary`, the stacks that update first, and `after`, each stack to the stacks it updates after |
| `engine` | a `plunge+` backend picks `plunge`, else Pulumi | `pulumi` or `plunge` |
| `backend` | `PULUMI_BACKEND_URL`, then `Pulumi.yaml`'s `backend.url` | the backend URL, for every stack or per stack under `stacks` |
| `gate` | `on-destructive` | `always`, `on-destructive` or `never`: when a wave waits for an approval |
| `approval` | `ledger` | `ledger`, `sealed` or `pr-review` |
| `approval_rules` | none | per stack glob, `role` or `roles` from `.chant/trust.json` and a `quorum` (default 1); read at base |
| `apply.when` | `merge` | `merge`, or `pull-request` for `/plywood up` before merge |
| `apply.requires` | all four | with `when: pull-request`, the conditions an open pull request meets before `/plywood up` updates it: `approved`, `mergeable`, `undiverged`, `checks` |
| `locks.when` | `preview` | `preview`, from the first preview, or `up`, from an update before merge or a `/plywood lock` comment |
| `locks.grain` | `resource` on plunge, `stack` on stock Pulumi | `resource` or `stack` |
| `policy.rego` | none | the directory of Rego rules: `deny_*` denies, `hold_*` waits for a person, `warn_*` is a note line |
| `policy.engine` | `conftest` | `conftest` or `opa`, the result shape the rules' engine prints; a hold needs `opa` |
| `policy.namespace` | every package (conftest), `main` (opa) | the Rego package to read |
| `policy.command` | the engine's own | the argv to run in place of the engine's; `{policy}` is the rules' directory at base, `{input}` the change set |
| `policy.source` | none | a shared rule set from another repository: `repo`, `ref` and `path` (default `policy`); `packs` are then paths inside it |
| `policy.packs` | none | CrossGuard packs the preview and the update run with `--policy-pack`; mandatory violations deny, advisory ones are note lines |
| `identity.preview`, `identity.up` | the job's own credentials | each job's identity per cloud: `aws` a role ARN, `gcp` a service account, `azure` a client id, `pulumi` a Pulumi Cloud token (`team:<name>`, `user:<login>`, `organization` or `organization:admin`) |
| `identity.stacks` | none | stack glob to its own `preview` and `up` identities; the first glob that matches wins |
| `identity.aws`, `identity.gcp`, `identity.azure` | none | each cloud's trade settings: `region`, `audience`, `endpoint`; `provider`, `audience`, `sts_endpoint`, `iam_endpoint`; `tenant_id`, `subscription_id`, `audience`, `authority` |
| `pulumi_cloud.org` | none | the Pulumi Cloud organization the stacks' state is in |
| `pulumi_cloud.api_url` | `https://api.pulumi.com` | the API of a self-hosted Pulumi Cloud |
| `pulumi_cloud.audience` | `urn:pulumi:org:<org>` | the OIDC token's audience |
| `review_stacks.template` | off | the stack a review stack's config starts from, as `project/stack` |
| `review_stacks.name` | `pr-{number}` | the review stack's name, `pr-{number}` or `pr-{number}-<suffix>`; only stacks named so are destroyed |
| `review_stacks.ttl` | chant's | how long a review stack lives after its last update, such as `72h` |
| `notify.slack.webhook`, `notify.teams.webhook` | off | the variable holding the incoming webhook's URL |
| `notify.webhook.url`, `notify.webhook.key` | off | the variables holding a generic webhook's URL and its signing key |
| `notify.on` | every event | the events to send |
| `notify.relay` | off | the variable holding the relay key, so a waiting wave's Slack and Teams messages carry an approval `plywood notify relay` records |
| `telemetry.endpoint` | off | the OTLP/HTTP base URL; `/v1/traces` is added |
| `telemetry.headers_env` | none | the variable holding the OTLP headers |
| `telemetry.service_name` | `plywood` | the trace's `service.name` |
| `telemetry.traces` | `true` | `false` turns traces off |
| `reports.url` | none | where each run's report is kept: `s3://`, `gs://`, `az://` or `file://` |
| `drift.schedule` | off | a five-field cron line the drift job runs on |
| `drift.stacks` | every stack | the stacks the drift job reads, by name or `project/*` glob |
| `respond.drift` | `issue` | `issue`, `pull-request` (the issue and the drift agent's pull request), `up` (the issue and a gated update) or `none` |
| `review` | off | `true`, or a mapping with `instructions` (default `.chant/review.md`), `command`, `key_env` (default `ANTHROPIC_API_KEY`) and `timeout` |
| `agent.comment` | `false` | answer `/plywood agent <ask>` on a pull request |
| `agent.drift` | `false` | open a pull request that fixes a drifted stack |
| `agent.command`, `agent.key_env`, `agent.timeout` | as for `review` | the model command, its key's variable and its minutes |
| `agent.max_runs` | none | the most agent runs per day |
| `agent.token_env` | the job token on GitHub and Forgejo, `CHANT_FORGE_TOKEN` on GitLab | the secret holding the token the agent's push job pushes with; a GitHub push with the job token starts no workflow, so name a user's or app's token here for the agent's commit to get a preview |
| `branches` | none | branch name to stack globs; a stack a glob matches updates from that branch alone |
| `labels` | none | pull request label to stack globs; a labelled pull request previews only the stacks its labels match |
| `forge.kind`, `forge.url` | read from the repository's remote | `github`, `gitlab` or `forgejo`, and the base URL of a self-hosted forge |
| `pulumi`, `plunge` | the image's release | the engine release the jobs run: one for every stack, or a map of stack glob to release |
| `image` | plywood's image for each stack's engine | an image pinned by digest, or a mapping with `name` and the `plugins` it carries |
| `runners` | chant's default runner | a label, a list of labels or a GitHub runner group; or `default`, `preview`, `up` and `drift` each mapped to one |
| `control` | off | the control repo this repository tells after each update on merge: a project key or URL, or a mapping with `repo`, `op` (default `pulumi-up`), `member`, `forge`, `token_secret`, `read_token_secret`, `ref` and `api_base` |

plywood turns each key into chant's workspace settings, so `plywood.yml` holds no chant key. A `ci` key there is refused with the name of the plywood key that sets it.
