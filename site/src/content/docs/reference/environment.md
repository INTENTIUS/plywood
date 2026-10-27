---
title: 'Environment variables'
description: 'The environment variables plywood and its engines read.'
needs: [plywood#1]
draft: true
---

| Variable | Read by | Meaning |
|---|---|---|
| `PULUMI_ACCESS_TOKEN` | preview, up | the Pulumi Cloud token for the job; the pipeline sets it from the preview or the up secret |
| `PULUMI_BACKEND_URL` | every stage | the backend, when `plywood.yml` does not name one |
| `PULUMI_CONFIG_PASSPHRASE` | preview, up | the passphrase for a passphrase secrets provider |
| `PLUNGE_REFRESH` | preview, up on plunge | `false` skips plunge's refresh before preview |
| `PLYWOOD_REPORT` | every stage | the report path, `.plywood/report.json` by default |
| `PLYWOOD_LOG` | every stage | `info` or `debug` |
