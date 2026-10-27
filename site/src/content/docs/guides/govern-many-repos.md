---
title: 'Govern many repositories'
description: 'One control repo sets policy and approvers for all of them.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

```yaml
control: https://github.com/acme/infra-control
```

Each repository's `plywood.yml` names the control repo. Its policies, `trust.json` and pins apply to every repository at the control repo's default branch. [The control repo](/plywood/concepts/control-repo/).
