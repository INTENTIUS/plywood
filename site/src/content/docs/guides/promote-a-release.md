---
title: 'Promote a release through environments'
description: 'Name the order of the environments, then carry a release into each one behind its gate.'
---

With `promotion` in `plywood.yml`, the merge updates the first environment's stacks. `plywood promote` then carries a release on to the next environment in the list.

## Name the order

List the environments first to last:

```yaml
stacks:
  shop/dev: { dir: infra }
  shop/staging: { dir: infra }
  shop/prod: { dir: infra, gate: always }
promotion: [dev, staging, prod]
```

Each project takes one stack per environment. plywood finds it by name: `shop/staging` for `staging`, or `shop/prod-east` for `prod`. A stack whose name says nothing about its environment goes under that environment's `targets`. Once the file has `environments`, it names every environment of `promotion`; give `{}` to one that sets nothing:

```yaml
promotion: [dev, staging, prod]
environments:
  dev: {}
  staging: {}
  prod:
    targets: { shop: live }
```

`plywood config check` refuses a project with no stack for an environment. It also refuses two stacks of a project in one environment; list each region as an environment of its own, as in `promotion: [dev, staging, prod-us, prod-eu]`. A stack that no environment takes is refused too.

Run `plywood init` again. It writes one component per project in `plywood.component.ts`, whose step names the stack of each environment. `chant.config.ts` lists the environments in order. The merge's waves update the first environment's stacks, and the pull request jobs preview them there.

## Cut a release

Cut a release once the first environment runs a good change. Without `--yes` the cut is a dry run that prints the plan:

```sh
npx chant release cut shop-2026-11-20 --yes
```

The release records each environment's stacks and their programs at that commit.

## Promote it

Name the release and the environment it goes to:

```sh
npx plywood promote --to staging --release shop-2026-11-20
```

The promote previews the release's program against the staging stacks alone, then updates them once the gate passes. `--from` defaults to the environment before `--to` in `promotion`. A promote that skips one, such as `--to prod --from dev`, is refused unless it says `--allow-skip`. `--dry-run` prints the plan and changes nothing.

## Pass the gate

An environment waits at the release gate when its stacks' `gate` is `always` or `on-destructive`. The gate binds the digest of the preview's change set, for this release in this environment. A change set that changes nothing passes on its own. Otherwise the promote exits 3 and prints a line such as:

```text
release gate: change set jcs1-sha256:a59a0a86... for "prod", 1 entry, 0 hole(s)
```

Someone other than the person promoting approves that digest:

```sh
npx plywood approve release --plan jcs1-sha256:a59a0a86...
```

Then run the same promote again. It updates the stacks the approval covers, and refuses a preview that has moved since.

## Go back

A release that misbehaves goes back through the same gate. [Roll the environment back](/plywood/guides/roll-back-a-stack/) to the release it ran before:

```sh
npx plywood rollback prod --release shop-2026-11-13
```
