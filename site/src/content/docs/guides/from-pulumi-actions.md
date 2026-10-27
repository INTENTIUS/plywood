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

`init` reads each `pulumi/actions` step's `command`, `stack-name`, `work-dir` and `cloud-url`, and writes:

- `plywood.yml`, with one stack entry per step;
- `.github/workflows/plywood.yml`, the generated pipeline.

## Run both, then remove the old one

Keep the old workflow for one pull request and compare the two. Delete its `preview` and `up` jobs once the plywood jobs are green. Secrets such as `PULUMI_ACCESS_TOKEN` carry over under the names `init` prints.
