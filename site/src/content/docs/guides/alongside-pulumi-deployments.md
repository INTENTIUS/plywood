---
title: 'Alongside Pulumi Deployments'
description: 'Some stacks keep deploying from Pulumi Deployments, and others run from your forge through plywood, on the same Pulumi Cloud organisation.'
---

Pulumi Deployments and plywood share one Pulumi Cloud organisation well. Each stack has one runner: Deployments, or your forge's CI through plywood. Pulumi Cloud keeps the state and history of both.

## Hand a stack to plywood

1. List the stack in `plywood.yml`. `npx plywood init --from deployments` reads its exported `Pulumi.<stack>.deploy.yaml` and lists each setting it could not carry.
2. Turn off the stack's Deployments triggers, so each push starts a single update.
3. Merge. plywood previews the next pull request that touches the stack.

## Settings, side by side

| Deployments setting | `plywood.yml` |
|---|---|
| Source path | `stacks.<name>.dir` |
| Branch | `branches.<branch>` |
| Path filters | `stacks.<name>.paths` |
| Environment variables | your forge's variables and secrets |
| Pre-run commands | the stack's program, or a prepared image named in `image` |
| OIDC | `identity`, with a preview identity beside the up one |
| Pull request template | `review_stacks.template` |
| ESC environment | stays in the stack config; stock Pulumi resolves it with the job's Pulumi Cloud token |

Stacks that suit Deployments, such as review stacks driven from Pulumi Cloud, keep working there.
