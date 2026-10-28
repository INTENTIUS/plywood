---
title: 'The control repo'
description: 'One home for the approvers and pins of many repositories.'
needs: [plywood#18, chant#4541, chant#4550]
draft: true
---

A control repo is an ordinary repository that sets the approvers and the engine pins for many repositories. Each repository names it in `plywood.yml`:

```yaml
control: github.com/acme/infra-control
```

The control repo keeps one entry per repository, and one for the defaults, as records on its ledger. An entry holds `plywood.yml` keys: `gate`, `approval`, `approval_rules`, `pulumi`, `plunge` and `image`. A reviewed `control.yml` on the control repo's default branch carries the changes, and its pipeline writes them with `plywood control import control.yml`.

`plywood control reconcile --apply` then opens a pull request on each repository whose `plywood.yml` differs from its entry. Nothing writes a repository's default branch.

Once a repository updates on merge, `plywood control dispatch` tells the control repo so. The control repo then runs the repositories that depend on it. `plywood control init` writes the control repo's workflow for that.
