---
title: 'Boot the example'
description: 'One command starts a local forge and an AWS emulator with an example repository. Nothing reaches a real cloud account.'
prompt: |
  Follow https://intentius.io/plywood/tutorial/ on this machine: build the images with `just images`, start the bench with `just tutorial-up` and report the three addresses it prints.
  Never run `pulumi up`, `plunge up`, `pulumi destroy` or `plywood approve`, override a policy denial, use `--mode up`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.
---

The tutorial runs on your laptop. It uses the `aws-ts` program from the [plunge corpus](https://github.com/INTENTIUS/plunge/tree/main/tests/plunge-corpus), a TypeScript Pulumi program with S3 buckets, SQS queues, SNS topics, a VPC and SSM parameters. Every AWS call goes to [floci](https://github.com/lex00/floci), a local AWS emulator.

## You need

- Docker
- Node.js 22 or later
- git and `jq`
- the Pulumi CLI and the AWS CLI

## Start the bench

From a checkout of plywood, build plywood's images into your local Docker, then start the bench:

```sh
just images
just tutorial-up
```

Every job runs in the `plywood-pulumi` image that `just images` builds. It has Pulumi and the plywood CLI installed. The runner never pulls that image. Without it, `just tutorial-up` stops before it starts anything. `PLYWOOD_TUTORIAL_JOB_IMAGE` names another image.

The command starts Forgejo with its runner and floci on `127.0.0.1` only, then prints three addresses:

| Name | Address | Role |
|---|---|---|
| Forgejo | `http://127.0.0.1:3390` | the forge, with a runner and the user `tutor` (password `plywood-tutorial-local`) |
| floci | `http://127.0.0.1:4590` | the AWS API every stack talks to, with the keys `test`/`test` |
| bucket | `s3://plywood-tutorial-state` on floci | the self-managed backend |

`PLYWOOD_TUTORIAL_FORGEJO_PORT` and `PLYWOOD_TUTORIAL_FLOCI_PORT` move the two ports. Inside the bench a job reaches the forge as `http://forgejo:3000` and floci as `http://floci:4566`.

It also pushes the example repository `tutor/shop`, the `aws-ts` program with four stacks, each initialised in the bucket:

| Stack | Region |
|---|---|
| `dev` | `us-east-1` |
| `staging` | `us-east-1` |
| `prod-us` | `us-east-1` |
| `prod-eu` | `eu-west-1` |

Each stack has its own `corpus:prefix`, `plw-<stack>`, so their resources never share a name. `source stack/.state/tutorial.env` gives your shell the bench's AWS endpoint and test keys along with the stacks' passphrase and a Forgejo token.

`just tutorial-down` removes the bench's containers and volumes and keeps the files under `stack/.state`. `just tutorial-reset` sets those files aside and starts again.
