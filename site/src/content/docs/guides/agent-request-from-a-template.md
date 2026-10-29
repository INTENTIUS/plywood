---
title: 'Have an agent request an app'
description: 'An agent asks for an app from a template, and the request goes through the same pull request and approval as a person''s.'
needs: [plywood#40]
draft: true
---

```sh
npx plywood mcp --propose
```

`plywood mcp --propose` is chant's MCP server on its propose tier. It serves the read tools of `plywood mcp` and adds `plywood:request_from_template`. That tool may open a pull request and nothing else. People still approve and merge the change. Without `--propose`, the server lists no request tool.

The tool takes the arguments of `plywood request`.

| Argument | Meaning |
|---|---|
| `template` | the template's name in the catalog |
| `version` | the template's version; the newest when left out |
| `name` | the app's name, which names its directory and the request branch |
| `app` | the app an add-on template joins |
| `inputs` | the template's inputs, by name |

A call opens one pull request on `request/<template>/<name>`, the same pull request `plywood request` opens, with `via: mcp` in its body. plywood previews it like any other change, and its update runs after a person approves the digest. A second call for the same request opens nothing and returns `existing: true`.

Pulumi templates are not available yet. They need a template registry and catalog in plywood. The tool refuses every call with that message and opens nothing.
