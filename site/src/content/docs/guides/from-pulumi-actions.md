---
title: 'From pulumi/actions in GitHub Actions'
description: 'plywood init reads your existing pulumi/actions workflow and writes plywood.yml and the generated pipeline next to it.'
needs: [plywood#21, chant#4541, chant#4550]
draft: true
---

`pulumi/actions` runs a Pulumi command in a GitHub Actions job. plywood keeps the same Pulumi commands and adds one note across stacks. It also adds waves, with gates bound to a preview digest.

## Read your workflow

```sh
npx plywood init --from .github/workflows/pulumi.yml
```

`init` reads each `pulumi/actions` step's `command`, `stack-name`, `work-dir`, `policyPacks`, `cloud-url` and `pulumi-version`, and writes:

- `plywood.yml`, with one stack entry per step;
- `.github/workflows/plywood.yml`, the generated pipeline.

An `up` on a push becomes the branch that updates the stack. `init` then lists each input it could not carry by file and step, `refresh` and `target` among them.

`--from pulumi-actions` reads every workflow under `.github/workflows`. The same flag reads other pipelines' files too:

| `--from` | Files |
|---|---|
| `deployments` | each `Pulumi.<stack>.deploy.yaml` exported from Pulumi Deployments |
| `spacelift` | `.spacelift/config.yml` |
| `env0` | `env0.workflow.yml` and `env0.yml` |

## Run both, then remove the old one

Keep the old workflow for one pull request and compare the two. Delete its `preview` and `up` jobs once the plywood jobs are green. Secrets such as `PULUMI_ACCESS_TOKEN` carry over under the names `init` prints.
