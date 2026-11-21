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
policy: { path: policy/, packs: [policy/aws-guard] }
drift: { schedule: "0 6 * * *" }
```

| Key | Default | Meaning |
|---|---|---|
| `stacks` | found by `init` | each stack as `project/stack`, with `dir`, `paths`, `gate`, `backend` and `actions` |
| `stacks.<stack>.actions` | none | the stack's day-2 actions, each a `name`, the `urn` of a `command:local:Command` or `command:remote:Command` resource in the stack, and a `description`; `config check` refuses a URN of another type, on another stack, and a name used twice |
| `waves` | one wave per environment, dev before staging before prod | a list of waves, each a list of stacks, the first wave the canary; or a mapping with `canary`, the stacks that update first, and `after`, each stack to the stacks it updates after |
| `engine` | a `plunge+` backend picks `plunge`, else Pulumi | `pulumi` or `plunge` |
| `backend` | `PULUMI_BACKEND_URL`, then `Pulumi.yaml`'s `backend.url` | the backend URL, for every stack or per stack under `stacks` |
| `gate` | `on-destructive` | `always`, `on-destructive` or `never`: when a wave waits for an approval |
| `approval` | `ledger` | `ledger`, `sealed` or `pr-review` |
| `preview` | `true` | `plywood init` sets `approvals.preview` in the waves spec, so a merged wave applies only the plans its pull request previewed, or exits 4. `false` leaves it out. It was off by default in 0.3.1 and 0.3.2 |
| `approval_rules` | none | per stack glob, `roles` from `.chant/trust.json` and a `count` of distinct approvers (default 1); read at base |
| `apply.when` | `merge` | `merge`, or `pull-request` for `/plywood up` before merge |
| `apply.requires` | all four | with `when: pull-request`, the conditions an open pull request meets before `/plywood up` updates it: `approved`, `mergeable`, `undiverged`, `checks` |
| `locks.when` | `preview` | `preview`, from the first preview, or `up`, from an update before merge or a `/plywood lock` comment |
| `locks.grain` | `resource` on plunge, `stack` on stock Pulumi | `resource` or `stack` |
| `policy.path` | none | the directory of Rego rules: `deny_*` denies, `hold_*` waits for a person, `warn_*` is a note line |
| `policy.engine` | `conftest` | `conftest` or `opa`, the result shape the rules' engine prints; a hold needs `opa` |
| `policy.namespace` | every package (conftest), `main` (opa) | the Rego package to read |
| `policy.command` | the engine's own | the argv to run in place of the engine's; `{policy}` is the rules' directory at base, `{input}` the change set |
| `policy.source` | none | a shared rule set from another repository: `repo`, `ref` and `path` (default `policy`); `packs` are then paths inside it |
| `policy.providers` | none | the provider packages a stack may use; `plywood init` writes them as `deny_provider_package` in `policy.path` and as the CrossGuard pack `policy/plywood-providers` |
| `policy.packs` | none | CrossGuard packs the preview and the update run with `--policy-pack`; mandatory violations deny, advisory ones are note lines |
| `cost.command` | none | the estimator: a command line or a list of arguments that names `{planJson}`, the stack's preview JSON, and prints the stack's monthly cost; plywood ships none |
| `cost.format` | `chant` | the format of the estimator's output: `chant`, a JSON object with `monthlyDelta`, or `infracost`'s JSON |
| `cost.currency` | the estimate's, else `USD` | the currency of the amounts, a three-letter code |
| `cost.approve_above` | off | the monthly change above which a preview needs an approval of its own and a wave waits for one; a stack the estimator could not price counts as over |
| `identity.preview`, `identity.up` | the job's own credentials | each job's identity per cloud: `aws` a role ARN, `gcp` a service account, `azure` a client id, `pulumi` a Pulumi Cloud token (`team:<name>`, `user:<login>`, `organization` or `organization:admin`) |
| `identity.stacks` | none | stack glob to its own `preview` and `up` identities; the first glob that matches wins |
| `identity.aws`, `identity.gcp`, `identity.azure` | none | each cloud's trade settings: `region`, `audience`, `endpoint`; `provider`, `audience`, `sts_endpoint`, `iam_endpoint`; `tenant_id`, `subscription_id`, `audience`, `authority` |
| `pulumi_cloud.org` | none | the Pulumi Cloud organization the stacks' state is in |
| `pulumi_cloud.api_url` | `https://api.pulumi.com` | the API of a self-hosted Pulumi Cloud |
| `pulumi_cloud.audience` | `urn:pulumi:org:<org>` | the OIDC token's audience |
| `ephemeral.template` | off | the stack a review stack's config starts from, as `project/stack` |
| `ephemeral.name` | `pr-{number}` | the review stack's name, `pr-{number}` or `pr-{number}-<suffix>`; only stacks named so are destroyed |
| `ephemeral.ttl` | chant's | how long a review stack lives after its last update, such as `72h` |
| `notify.slack`, `notify.teams` | off | the variable holding the incoming webhook's URL |
| `notify.webhook`, `notify.webhook_key` | off | the variables holding a generic webhook's URL and its signing key |
| `notify.events` | every event | the events to send: `waiting`, `refused`, `failed`, `drift` |
| `notify.relay_key` | off | the variable holding the relay key, so a waiting wave's Slack and Teams messages carry an approval `plywood notify relay` records |
| `telemetry.endpoint` | off | the OTLP/HTTP base URL; `/v1/traces` is added |
| `telemetry.headers_secret` | none | the variable holding the OTLP headers |
| `telemetry.service_name` | `plywood` | the trace's `service.name` |
| `telemetry.traces` | `true` | `false` turns traces off |
| `reports.bucket` | none | the reports bucket, where each run's report is kept and `plywood estate` writes `estate.json`, `dora.json` and `audit.jsonl`: `s3://`, `gs://`, `az://` or `file://`; `reports.url` is read as the same key |
| `drift.schedule` | off | a five-field cron line the drift job runs on |
| `drift.stacks` | every stack | the stacks the drift job reads, by name or `project/*` glob |
| `respond.wave-refused` | `diff` | `diff`, `summary` (the diff with a model's summary above it) or `off` |
| `agent.wave-refused` | chant's defaults | the model run behind `summary`: `command`, `key_secret`, `timeout`, `max_runs` and `max_cost_usd`, each optional |
| `respond.drift` | `issue` | `issue`, `pull-request` (the issue and the drift agent's pull request), `up` (the issue and a gated update) or `off` |
| `review` | off | `true`, or a mapping with `instructions` (default `.chant/review.md`), `command`, `key_secret` (default `ANTHROPIC_API_KEY`) and `timeout` |
| `agent.comment` | `false` | answer `/plywood agent <ask>` on a pull request; `plywood ci` writes the agent's workflow, `.chant/ops/plywood-agent.spec.json` and `ops/plywood-agent.op.ts`, the Op the workflow runs under; commit them together |
| `agent.drift` | `false` | open a pull request that fixes a drifted stack |
| `agent.command`, `agent.key_secret`, `agent.timeout` | as for `review` | the model command, its key's variable and its minutes |
| `agent.max_runs` | none | the most agent runs per day |
| `agent.token_env` | the job token on GitHub and Forgejo, `CHANT_FORGE_TOKEN` on GitLab | the secret holding the token the agent's push job pushes with; a GitHub push with the job token starts no workflow, so name a user's or app's token here for the agent's commit to get a preview |
| `branches` | none | branch name to stack globs; a stack a glob matches updates from that branch alone |
| `labels` | none | pull request label to stack globs; a labelled pull request previews only the stacks its labels match |
| `forge`, `forge_url` | read from the repository's remote | `github`, `gitlab` or `forgejo`, and the base URL of a self-hosted forge |
| `pulumi`, `plunge` | the image's release | the engine release the jobs run: one for every stack, or a map of stack glob to release |
| `image` | plywood's image for each stack's engine | an image pinned by digest, or a mapping with `name` and the `plugins` it carries |
| `runner` | chant's default runner | a label, a list of labels or a GitHub runner group; or `default`, `preview`, `up` and `drift` each mapped to one |
| `env` | none | variable to value, set in the preview, up and drift jobs; values are written into the workflow, so a secret goes under `pass` |
| `pass.secrets` | none | secrets the jobs read as variables, by name: `pass.secrets`, a list of secret names, or a mapping of variable to secret; the workflow names the secret and never holds its value |
| `parallelism` | a preview runs a wave's stacks at once, an update one at a time | the most stacks a preview or an update runs at once in a wave |
| `forge_environments` | none | stack glob to the forge deployment environment its up jobs run in, a name or a mapping with `name` and `url`; the first glob that matches wins, a wave whose stacks are in different environments runs one job per environment, and `plywood forge check` checks each up job against it (GitHub and GitLab) |
| `evidence.identity` | off | `oidc`: the wave jobs sign their `plan` and `policy` checks keyless, from each job's OIDC token; `plywood init` writes the waves workflow's identity into `.chant/trust.json` ([Sign the checks](/plywood/guides/sign-checks/)) |
| `evidence.audience` | `sigstore` | with `identity`, the OIDC token's audience |
| `evidence.runner_key_secret` | off | in place of `identity`, the secret (a CI/CD variable on GitLab) holding the runner key the wave jobs sign with |
| `evidence.local` | `false` | `true`: `plywood init` names the check hooks under `local.checks` in `.chant/trust.json`, so a hook proven on a person's machine is skipped in CI |
| `control` | off | the control repo this repository tells after each update on merge: a project key or URL, or a mapping with `repo`, `op` (default `pulumi-up`), `member`, `forge`, `token_secret`, `read_token_secret`, `ref` and `api_base` |

## Earlier spellings

The keys above are the ones on chant's product config reference. Each earlier spelling below reads as its key, and `plywood config check` warns on it with the key's name. A spelling set beside its key is an error.

| Spelling | Key |
|---|---|
| `environments`, a glob to a name or `{ name, url }` | `forge_environments` |
| `approval_rules.<rule>.quorum` | `approval_rules.<rule>.count` |
| `approval_rules.<rule>.role` | `approval_rules.<rule>.roles` |
| `policy.rego` | `policy.path` |
| `respond.wave_refused` | `respond.wave-refused` |
| `respond.apply_failed` | `respond.apply-failed` |
| `respond.drift: none` | `respond.drift: off` |
| `reports.url`, a storage URL | `reports.bucket` |
| `telemetry.headers_env` | `telemetry.headers_secret` |
| `review_stacks`, `review_stacks.ttl` | `ephemeral`, `ephemeral.ttl` |
| `forge.kind` | `forge` |
| `forge.url` | `forge_url` |
| `pass`, a list or a mapping | `pass.secrets` |
| `notify.slack.webhook`, `notify.teams.webhook` | `notify.slack`, `notify.teams` |
| `notify.webhook.url` | `notify.webhook` |
| `notify.webhook.key` | `notify.webhook_key` |
| `notify.on` | `notify.events` |
| `notify.relay` | `notify.relay_key` |
| `review.key_env`, `agent.key_env` | `review.key_secret`, `agent.key_secret` |
| `runners` | `runner` |

plywood turns each key into chant's workspace settings, so `plywood.yml` holds no chant key. A `ci` key there is refused with the name of the plywood key that sets it.
