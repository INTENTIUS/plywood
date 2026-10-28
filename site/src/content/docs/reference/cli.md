---
title: 'CLI'
description: 'Every plywood command and flag.'
needs: [plywood#7, plywood#8, chant#4541, chant#4550]
draft: true
---

| Command | Does |
|---|---|
| `plywood init [--gate] [--engine] [--forge] [--from]` | writes `plywood.yml` and the pipeline |
| `plywood upgrade [<version>] [--chant] [--no-install] [--dry-run]` | moves `@intentius/plywood` and the chant packages to a release, installs them, and writes the workflow again with it |
| `plywood check` | validates `plywood.yml`, each stack's config and the program's dependencies |
| `plywood preview [--stack] [--target]` | previews each stack and writes the report |
| `plywood up [--wave]` | updates the stacks of an approved wave |
| `plywood resume [--op] [--wave]` | starts the wave jobs an approval has cleared since they stopped |
| `plywood drift [--stack]` | reads each stack against the cloud |
| `plywood approve <gate> --plan <digest> [--pr] [--sign]` | records an approval of one digest; `up` finds its pull request from the digest |
| `plywood override <gate> --rule <id> --reason <text>` | records an override of one denial |
| `plywood rollback <stack> --release <name>` | previews and updates a release's tree |
| `plywood cancel <stack> [--lock <id>]` | releases a stuck stack lock once a second person approves; reads the id from a `file://` backend |
| `plywood audit [--since] [--stack] [--json]` | reads the ledger |

## Comments

| Comment | Does |
|---|---|
| `/plywood preview [stack]` | previews the head again |
| `/plywood up [wave]` | updates from the pull request, with `apply.when: pull-request` |
| `/plywood lock`, `/plywood unlock` | takes or frees the pull request's locks |

Exit codes are on [Exit codes](/plywood/reference/exit-codes/).
