---
title: 'From pulumi/actions in GitHub Actions'
description: 'plywood init reads your existing pulumi/actions workflow and writes plywood.yml and the generated pipeline next to it.'
---

`pulumi/actions` runs a Pulumi command in a GitHub Actions job. plywood keeps the same Pulumi commands and adds one note across stacks. It also adds waves, with gates bound to a preview digest.

## Read your workflow

```sh
npx plywood init --from .github/workflows/pulumi.yml
```

`init` reads each `pulumi/actions` step's `command`, `stack-name`, `work-dir`, `policyPacks`, `cloud-url` and `pulumi-version`, and writes:

- `plywood.yml`, with one stack entry per step;
- `.chant/op-waves/pulumi-up.spec.json`, the waves a merge updates in;
- `.github/workflows/plywood.yml`, the generated pipeline.

An `up` on a push becomes `branches.<branch>`, the branch that updates the stack. An `up` on a pull request becomes `apply.when: pull-request`. The org in `stack-name` goes to `pulumi_cloud.org`. `init` then lists each input it could not carry, by file, with the reason; `refresh` and `target` are among them. It leaves the old workflow as it is.

`--from pulumi-actions` reads every workflow under `.github/workflows`, `.forgejo/workflows` and `.gitea/workflows`. The same flag reads other pipelines' files too:

| `--from` | Files |
|---|---|
| `deployments` | each `Pulumi.<stack>.deploy.yaml` (or `.json`) exported from Pulumi Deployments |
| `spacelift` | `.spacelift/config.yml` |
| `env0` | `env0.workflow.yml` and `env0.yml` |

## Run both, then remove the old one

Keep the old workflow for one pull request and compare the two. Delete its `preview` and `up` jobs once the plywood jobs are green. `PULUMI_ACCESS_TOKEN` does not carry over. `init` asks you to set `pulumi_cloud.org` and the Pulumi Cloud tokens in `identity`, so each job trades its OIDC token for its own. Repository secrets named `PULUMI_ACCESS_TOKEN_PREVIEW` and `PULUMI_ACCESS_TOKEN_UP` work too.
