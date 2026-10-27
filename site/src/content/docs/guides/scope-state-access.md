---
title: 'Scope state and cloud access'
description: 'Preview and update run as different identities, and on Pulumi Cloud they use different tokens.'
needs: [plywood#14, chant#4541, chant#4549, chant#4550]
draft: true
---

plywood switches on chant's [cloud identities](https://intentius.io/chant/guide/security-cloud-identities/).

```yaml
identity:
  preview: { aws: arn:aws:iam::111111111111:role/pulumi-preview }
  up: { aws: arn:aws:iam::111111111111:role/pulumi-up }
```

The OIDC trade happens before the pull request's code is checked out, and later steps never see the token variables. plywood refuses one role for both.

On Pulumi Cloud, the preview job and the update job log in with separate access tokens, so the job that runs a pull request's program never holds the token that updates.
