---
title: 'Alongside Pulumi Deployments'
description: 'Some stacks keep deploying from Pulumi Deployments, and others run from your forge through plywood, on the same Pulumi Cloud organisation.'
needs: [plywood#1, chant#4541, chant#4549, chant#4550]
draft: true
---

Pulumi Deployments and plywood share one Pulumi Cloud organisation well. Each stack has one runner: Deployments, or your forge's CI through plywood. Pulumi Cloud keeps the state and history of both.

## Hand a stack to plywood

1. List the stack in `plywood.yml`.
2. Turn off the stack's Deployments triggers, so each push starts a single update.
3. Merge. plywood previews the next pull request that touches the stack.

## Settings, side by side

| Deployments setting | `plywood.yml` |
|---|---|
| Source path | `stacks.<name>.dir` |
| Branch | `branches` |
| Path filters | `stacks.<name>.paths` |
| Environment variables | your forge's variables and secrets |
| Pre-run commands | `steps.before` |
| ESC environment | stays in the stack config, and the job reads it as Pulumi does |

Stacks that suit Deployments, such as review stacks driven from Pulumi Cloud, keep working there.
