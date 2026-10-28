---
title: 'Read your stacks over MCP'
description: 'An agent reads your stacks and their runs with read-only tools.'
---

```sh
npx plywood mcp
```

`plywood mcp` is chant's read-only MCP server over stdio, with plywood's tools added. Add it to your agent's MCP config. It serves chant's read tools over the workspace ledger and graph and over the run reports. plywood adds `plywood:stacks`, `plywood:settings`, `plywood:tips` and `plywood:verbs`. It has no tool that runs or approves anything; to change a stack, the agent opens a pull request. `--report-url <url>` names where the run reports are kept. [chant mcp](https://intentius.io/chant/cli/mcp/).
