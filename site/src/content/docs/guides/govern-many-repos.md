---
title: 'Govern many repositories'
description: 'One control repo sets the approvers and pins for all of them.'
---

```yaml
control: github.com/acme/infra-control
```

Each repository's `plywood.yml` names the control repo. After an update on merge the repository tells the control repo which stack applied. The control repo then runs the repositories that depend on it, from the workflow `plywood control init` writes there. `control put` sets the approvers or pins for one repository or for all of them:

```sh
plywood control put github.com/acme/shop --approver 'shop/prod-*=sre:2'
plywood control put defaults --pin pulumi=3.272.0
plywood control reconcile
```

Each entry is a record on the control repo's ledger. `reconcile` prints the `plywood.yml` change each repository would get, and `--apply` opens the pull requests. [The control repo](/plywood/concepts/control-repo/).
