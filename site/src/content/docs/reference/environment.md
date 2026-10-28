---
title: 'Environment variables'
description: 'The environment variables plywood and its engines read.'
---

| Variable | Read by | Meaning |
|---|---|---|
| `BASE_SHA` | check, preview | the base commit, when `--base` is not given |
| `PR_NUMBER` | preview, approve | the pull request number, when `--pr` is not given |
| `PULUMI_ACCESS_TOKEN` | preview, up | the Pulumi Cloud token for the job, traded from its OIDC token: a preview token in the preview job and an up token in the up job. Stock Pulumi opens ESC environments with it |
| `PULUMI_ACCESS_TOKEN_PREVIEW`, `PULUMI_ACCESS_TOKEN_UP` | preview, up | repository secrets holding a Pulumi Cloud token per job, for a repository without `identity` tokens in `plywood.yml` |
| `PULUMI_BACKEND_URL` | every stage, `init` | the backend, when `plywood.yml` does not name one |
| `PULUMI_CONFIG_PASSPHRASE` | preview, up | the passphrase for a passphrase secrets provider |
| `PLUNGE_REFRESH` | preview, up on plunge | `false` skips plunge's refresh before preview and update |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and the other `OTEL_*` variables | every stage | the trace exporter; they win over `telemetry` in `plywood.yml` |
