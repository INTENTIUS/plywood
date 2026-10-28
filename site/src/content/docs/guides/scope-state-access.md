---
title: 'Scope state and cloud access'
description: 'Preview and update run as different identities, and on Pulumi Cloud they use different tokens.'
---

plywood switches on chant's [cloud identities](https://intentius.io/chant/guide/security-cloud-identities/).

```yaml
identity:
  preview: { aws: arn:aws:iam::111111111111:role/pulumi-preview }
  up: { aws: arn:aws:iam::111111111111:role/pulumi-up }
  stacks:
    "shop/prod-*":
      preview: { aws: arn:aws:iam::222222222222:role/pulumi-preview }
      up: { aws: arn:aws:iam::222222222222:role/pulumi-up }
```

The OIDC trade happens before the pull request's code is checked out, and later steps never see the token variables. plywood refuses one identity for both stages. A stack glob takes the first rule that matches it, then the every-stack pair. `plywood config identities` prints the identity each stack takes.

On Pulumi Cloud, give each stage its own token. Each job then trades its OIDC token for its own access token:

```yaml
pulumi_cloud:
  org: acme
identity:
  preview: { pulumi: team:ci-preview }
  up: { pulumi: team:ci-up }
```

The job that runs a pull request's program never holds the token that updates. Stock Pulumi opens a stack's ESC environments with the job's token.
