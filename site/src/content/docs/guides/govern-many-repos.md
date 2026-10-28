---
title: 'Govern many repositories'
description: 'One control repo sets policy and approvers for all of them.'
needs: [plywood#18, chant#4541, chant#4550]
draft: true
---

```yaml
control: github.com/acme/infra-control
```

Each repository's `plywood.yml` names the control repo. The control repo sets an approver or a pin for one repository or for all of them:

```sh
plywood control put github.com/acme/shop --approver 'shop/prod-*=sre:2'
plywood control put defaults --pin pulumi=3.272.0
plywood control reconcile
```

`reconcile` prints the change each repository would get, and `--apply` opens the pull requests. [The control repo](/plywood/concepts/control-repo/).
