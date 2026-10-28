---
title: 'Add plywood to a repo'
description: 'plywood init finds each Pulumi.yaml and its stacks, writes plywood.yml and the waves spec, and renders the pipeline for your forge.'
prompt: setup
---

```sh
npm i -D @intentius/plywood
npx plywood init
```

`init` does five things:

1. Finds each `Pulumi.yaml` and lists its stacks from the `Pulumi.<stack>.yaml` files beside it.
2. Writes `plywood.yml` with only the settings it could not read from the repository. A `plywood.yml` already there is kept as it is.
3. Writes the waves a merge updates in to `.chant/op-waves/pulumi-up.spec.json`: one wave per environment, the first wave the canary.
4. Renders the pipeline for the forge your `origin` remote names: `.github/workflows/plywood.yml`, `.gitlab-ci.yml` or `.forgejo/workflows/plywood.yml`, and the wave jobs beside it.
5. Prints the secrets and settings left for you to add.

It also writes `chant.workspace.json`, `chant.config.ts`, `plywood.component.ts` and `ops/pulumi-up.op.ts`, which chant reads. The last is the `pulumi-up` Op the waves run under; run by hand with `npx chant run pulumi-up`, it previews each stack in wave order. Commit them with the rest.

The pipeline is chant's [pull request CI](https://intentius.io/chant/guide/pull-request-ci/) with plywood's words on its notes, statuses and comments.

## Options

| Flag | Effect |
|---|---|
| `--preset merge\|before-merge\|approve-all` | when updates run and when a wave waits; `merge` when left out |
| `--gate always\|on-destructive\|never` | when a wave waits for an approval |
| `--engine pulumi\|plunge` | the engine the stacks run; `init` picks plunge only with this flag |
| `--from <source>[=<file>]` | read `pulumi-actions`, `deployments`, `spacelift` or `env0` settings from the repository, or from the files named |
| `--forge github\|gitlab\|forgejo` | the forge, when `origin` does not say |
| `--dry-run` | print the files `init` would write, and write none |

## Per forge

| Forge | Pipeline file | Status |
|---|---|---|
| GitHub | `.github/workflows/plywood.yml` | `plywood/preview` check |
| GitLab | `.gitlab-ci.yml` | `plywood/preview` external status |
| Forgejo | `.forgejo/workflows/plywood.yml` | `plywood/preview` commit status |

Make `plywood/preview` a required status on the default branch. [plywood.yml](/plywood/reference/config/) lists every key.
