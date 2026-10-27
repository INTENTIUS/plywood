---
title: 'Boot the example'
description: 'One command starts a local forge and an AWS emulator with an example repository. Nothing reaches a real cloud account.'
needs: [plywood#11]
draft: true
prompt: |
  Follow https://intentius.io/plywood/tutorial/ on this machine: start the bench with `just tutorial-up` and report the three addresses it prints.
  Never run `pulumi up`, `plunge up`, `pulumi destroy` or `plywood approve`, override a policy denial, use `--mode up`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

The tutorial runs on your laptop. It uses the `aws-ts` program from the [plunge corpus](https://github.com/INTENTIUS/plunge/tree/main/tests/plunge-corpus), a TypeScript Pulumi program with S3 buckets, SQS queues, an SNS topic, a VPC and SSM parameters. Every AWS call goes to [floci](https://github.com/lex00/floci), a local AWS emulator.

## You need

- Docker
- Node.js 22 or later
- git
- the Pulumi CLI

## Start the bench

From a checkout of plywood:

```sh
just tutorial-up
```

The command starts three containers and prints their addresses:

| Container | Address | Role |
|---|---|---|
| Forgejo | `http://localhost:3000` | the forge, with a runner and a user `tutor` |
| floci | `http://localhost:4566` | the AWS API every stack talks to |
| bucket | `s3://plywood-tutorial-state` on floci | the self-managed backend |

It also pushes the example repository `tutor/shop` with the `aws-ts` program and four stacks.

| Stack | Role |
|---|---|
| `dev` | the canary |
| `staging` | the second wave |
| `prod-east`, `prod-west` | the third wave | Each stack has its own `corpus:prefix`, so their resources never share a name.

`just tutorial-down` stops the bench and removes it.
