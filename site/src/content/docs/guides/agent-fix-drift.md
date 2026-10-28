---
title: 'Have an agent fix drift'
description: 'The agent opens a pull request that brings the program back in line with the drift found. A person approves the update.'
---

```yaml
drift:
  schedule: "0 6 * * *"
respond:
  drift: pull-request
agent:
  drift: true
  max_runs: 5
```

When a scheduled drift run finds a drifted stack, plywood keeps one issue for it. The agent then changes the program to match the live value. It opens a pull request from a `plywood/agent/` branch, or updates the one it opened before. The agent may not change `plywood.yml` or the policy directory.

The pull request gets its own preview note, and a person approves it like any other. A GitHub push with the job token starts no workflow. Set `agent.token_env` to the secret holding a user's or app's token so the agent's commit gets its preview.

`agent.drift` does nothing unless `respond.drift` is `pull-request`. `agent.max_runs` caps the agent runs per day; `agent.command` and `agent.key_env` name the model command and the variable holding its key (`ANTHROPIC_API_KEY` by default).
