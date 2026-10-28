---
title: 'CLI'
description: 'Every plywood command and flag.'
---

Every command takes `--json`, which prints one JSON object on stdout in place of the text. `plywood --help` prints this list, and `plywood --version` the release.

## Setup

| Command | Does |
|---|---|
| `plywood init [--preset <name>] [--gate <when>] [--engine pulumi\|plunge] [--forge <kind>] [--env <env>] [--from <source>[=<file>]] [--no-bucket-check] [--dry-run] [--yes]` | writes `plywood.yml`, the stacks and the workflow, from the repository |
| `plywood init --from <source>` | reads `pulumi-actions`, `deployments`, `spacelift` or `env0` settings into `plywood.yml` |
| `plywood init --print-prompt` | prints the prompt that has a coding agent set plywood up |
| `plywood upgrade [<version>] [--chant <version>] [--forge <kind>] [--env <env>] [--no-install] [--dry-run]` | moves `@intentius/plywood` and the chant packages to a release, installs them, and writes the workflow again |
| `plywood ci [--forge <kind>] [--env <env>] [--output <file>] [--dry-run]` | writes the pull request workflow |
| `plywood config check [--file <path>]` | checks `plywood.yml` and prints the settings in force |
| `plywood config identities [--file <path>] [--env <env>]` | prints the preview and up identity each stack takes, per cloud |
| `plywood forge check [--env <env>] [--forge <kind>] [--repo <owner/name>] [--branch <b>] [--require-clouds]` | prints the identities next to the forge, cloud and Pulumi Cloud setup |

## Stages

| Command | Does |
|---|---|
| `plywood check [--base <rev>] [<target>...]` | checks `plywood.yml`, then runs the check hooks at the base commit |
| `plywood preview [<stack>] [--base <rev>] [--pr <n>] [--forge <kind>]` | previews the stacks the change reaches; `--forge` posts the note |
| `plywood tips [<id>]` | prints the tips a preview can name, or the one named |
| `plywood up [--wave <k>] [--decide \| --share <i> \| --group <name>]` | runs the merge's waves through the `pulumi-up` step |
| `plywood up --pr <n> [--base <rev>]` | updates an open pull request, with `apply.when: pull-request` |
| `plywood resume [--op <op>] [--wave <k>] [--dry-run]` | starts the wave jobs an approval has cleared since they stopped |
| `plywood drift [<stack>...] [--resource <urn>] [--forge <kind>] [--respond issue\|pull-request\|up\|none]` | reads each stack against the cloud; `--forge` keeps one issue per stack |

## Approvals

| Command | Does |
|---|---|
| `plywood approve <gate> --plan <digest> [--pr <n>] [--stack <stack>] [--sign] [--yes]` | records an approval of one digest at `up` (a pull request), `review` (its review stack) or `wave-<k>`; `up` finds its pull request from the digest when `--pr` is left out |
| `plywood override <stack> --rule <id>... --reason <text> [--plan <digest>] [--sign]` | records an override of a policy denial, spent once its update runs |

## Stack operations

Each one is a request on the workspace ledger and runs once a second person approves it.

| Command | Does |
|---|---|
| `plywood export <stack> --out <file>` | writes the stack's export to a file on your machine |
| `plywood cancel <stack> [--lock <id>]` | releases a stuck stack lock; on a `file://` backend it reads the id |
| `plywood move <urn>... --from <stack> --to <stack>` | moves resources between stacks; both stacks then preview no change |
| `plywood move <stack> --onto plunge` | adopts the stacks onto plunge, through `plywood.adopt.op.ts` |
| `plywood rollback <stack> [--digest <d>]` or `plywood rollback --release <name> --env <env>` | previews a release's program, then updates behind its gate |

## Ledger

| Command | Does |
|---|---|
| `plywood audit [approvals\|updates\|runs\|review-stacks] [--stack <s>] [--since <t>] [--where <f>=<v>]...` | prints the workspace ledger's rows |
| `plywood query "<sql>"` | runs SQL over the ledger's tables |
| `plywood estate [--report-url <url>] [--prefix <p>] [--fail-overdue]` | writes the estate page, with overdue drift checks and delivery metrics |
| `plywood notify relay` | receives Approve clicks from Slack and Teams and records them |

## Control repo

| Command | Does |
|---|---|
| `plywood control init [--forge <kind>]` | writes, in the control repo, the workflow that runs each repository's dependents |
| `plywood control put <host/owner/name>\|defaults [--approver <glob>=<role>[:<n>]]... [--pin <tool>=<v>]... [--file <yml>]` | sets one entry's approvers and pins on the control repo's ledger |
| `plywood control import <yml>`, `control list`, `control retire <host/owner/name>` | loads, lists and retires entries |
| `plywood control reconcile [--apply] [--project <key>]` | opens a pull request in each repository with its `plywood.yml` from its entry |
| `plywood control dispatch [--sha <sha>]` | tells the control repo in `plywood.yml` that this commit applied |

## Agents

| Command | Does |
|---|---|
| `plywood mcp [--report-url <url>]` | runs a read-only MCP server over stdio, with plywood's read tools |
| `plywood guard check <command line>` | prints whether the agent guard refuses a command |
| `plywood guard install [--dir <d>]` | installs the Claude Code hook and the `pulumi` and `plunge` wrappers |

The generated jobs also call `plywood ci <sub>`, `plywood components`, `plywood run`, `plywood lock`, `plywood unlock` and `plywood ledger`, which run chant's commands of the same name with plywood's words.

## Comments

| Comment | Does |
|---|---|
| `/plywood up [wave]` | updates from the pull request, with `apply.when: pull-request` |
| `/plywood lock`, `/plywood unlock` | takes or frees the pull request's locks |
| `/plywood agent <ask>` | hands the ask to the agent, with `agent.comment: true` |

Exit codes are on [Exit codes](/plywood/reference/exit-codes/).
