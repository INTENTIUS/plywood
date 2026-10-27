---
title: 'Add plywood to a repo'
description: 'plywood init finds each Pulumi.yaml and its stacks, writes plywood.yml and renders the pipeline for your forge.'
needs: [plywood#9, chant#4541, chant#4550]
draft: true
prompt: setup
---

```sh
npm i -D @intentius/plywood
npx plywood init
```

`init` does four things:

1. Finds each `Pulumi.yaml` and lists its stacks from the `Pulumi.<stack>.yaml` files beside it.
2. Writes `plywood.yml` with one wave per environment, the first stack as the canary.
3. Renders the pipeline for the forge your `origin` remote names: `.github/workflows/plywood.yml`, `.gitlab-ci.yml` or `.forgejo/workflows/plywood.yml`.
4. Prints the secrets and settings left for you to add.

The pipeline is chant's [pull request CI](https://intentius.io/chant/guide/pull-request-ci/) with plywood's words on its notes, statuses and comments.

## Options

| Flag | Effect |
|---|---|
| `--gate always\|destroy\|never` | when a wave waits for an approval |
| `--engine pulumi\|plunge` | the engine every stage runs |
| `--from <workflow>` | read an existing `pulumi/actions` workflow |
| `--forge github\|gitlab\|forgejo` | the forge, when `origin` does not say |

## Per forge

| Forge | Pipeline file | Status |
|---|---|---|
| GitHub | `.github/workflows/plywood.yml` | `plywood/preview` check |
| GitLab | `.gitlab-ci.yml` include | `plywood/preview` external status |
| Forgejo | `.forgejo/workflows/plywood.yml` | `plywood/preview` commit status |

Make `plywood/preview` a required status on the default branch. [plywood.yml](/plywood/reference/config/) lists every key.
