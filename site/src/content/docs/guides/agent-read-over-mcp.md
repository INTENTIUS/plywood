---
title: 'Read your stacks over MCP'
description: 'An agent reads your stacks and their runs with read-only tools.'
needs: [plywood#19, chant#4543]
draft: true
---

```sh
npx chant serve mcp --read-only
```

Add the server to your agent's MCP config. Its tools list stacks, runs, waiting gates, approvals and drift, all read-only. [chant mcp](https://intentius.io/chant/cli/mcp/).
