---
title: 'Start an agent from an alert or a schedule'
description: 'A pull request from an agent, started by a production alert, a failed update or a cron, reviewed by a person like any other change.'
---

```yaml
agent:
  alert: true
  apply-failed: true
  schedule:
    cron: "0 7 * * 1"
    task: Raise each provider and module version pin to the newest release that keeps the preview clean.
  max_runs: 5
```

Each key turns on one agent. With no key set, no agent exists. An agent changes the program and opens a pull request. It never applies, approves or merges. The pull request gets a preview and waits for a person like any other. `plywood ci` writes each agent's workflow beside the others and adds an Op file and a spec under `.chant/ops/`. Commit them as one change.

`agent.max_runs` caps the runs of each agent per day. `agent.command`, `agent.key_env`, `agent.timeout` and `agent.token_env` work as they do for [an agent that fixes drift](/plywood/guides/agent-fix-drift/). The agent may not change `plywood.yml` or the policy directory.

## Answer a production alert

`agent.alert` turns on the alert agent. chant's relay takes alerts from the sources in the table below. It checks each one and records it as a signed fact on the `chant/lifecycle` branch. Then it starts the agent's workflow, `plywood-alert-agent`. The workflow also runs every 15 minutes and picks up any alert whose start did not arrive.

Point an alert source at the relay's address `POST /alert/<source>`:

| Source | Address | Secret the relay holds |
|---|---|---|
| Alertmanager | `/alert/alertmanager` | `CHANT_ALERT_SECRET_ALERTMANAGER`, sent as the receiver's bearer token |
| PagerDuty | `/alert/pagerduty?member=<stack>` | `CHANT_ALERT_SECRET_PAGERDUTY`, the webhook's signing secret |
| Datadog | `/alert/datadog` | `CHANT_ALERT_SECRET_DATADOG`, sent in the header `X-Chant-Alert-Token` |
| Honeycomb | `/alert/honeycomb?member=<stack>` | `CHANT_ALERT_SECRET_HONEYCOMB`, the recipient's shared secret |
| Sentry | `/alert/sentry?member=<stack>` | `CHANT_ALERT_SECRET_SENTRY`, the integration's client secret |
| Any other | `/alert/generic` | `CHANT_ALERT_SECRET`, the HMAC-SHA256 of `<timestamp>.<body>` in `X-Chant-Signature` |

A source is on once the relay has its secret. The relay's `CHANT_ALERT_DISPATCH_TOKEN` starts the workflow on the alert, and it accepts a token that can run workflows and nothing more. chant's notify guide has the payloads for each source and the relay's settings.

The member an alert is for is the stack name from the alert's `member` label or tag, or from the address's `?member=`. One run answers one stack: it takes the oldest new alert and every alert for the same stack within the next `agent.alert.window` minutes (15 when unset). The change goes to the branch `plywood/agent/plywood-alert-agent-<stack>`, and the next alert for the stack updates the same pull request.

```yaml
agent:
  alert:
    window: 20
    relay_key_secret: PLYWOOD_RELAY_KEY
  max_runs: 5
```

`agent.alert.relay_key_secret` names the secret holding the relay key that signs the alert facts and checks them. It is `CHANT_RELAY_KEY` when unset. The agent job that reads the facts and the push job hold it; the model's step does not.

On GitLab the relay's trigger token starts a pipeline of the whole `.gitlab-ci.yml`. Put `- if: '$CI_PIPELINE_SOURCE == "trigger"'` with `when: never` first in the `rules` of each job of your own, starting with deploy jobs. `plywood ci` names each job that lacks the rule.

## Answer a failed update

`agent.apply-failed` turns on the failed-update agent, `plywood-apply-failed-agent`. When a wave job of the update on merge, or the update before merge, fails, it records one fact for each stack that did not update. Each fact is signed with the relay key. The triage comment posts as before. The agent's workflow runs every 15 minutes and by hand, and opens a pull request from `plywood/agent/plywood-apply-failed-agent-<stack>` with the engine's error output in its prompt.

```yaml
agent:
  apply-failed:
    window: 15
    relay_key_secret: PLYWOOD_RELAY_KEY
  max_runs: 4
```

`plywood ci` puts the relay key on each wave job's command step, and on the update before merge when `apply.when` is `pull-request`. Set the secret named in `relay_key_secret`, or `CHANT_RELAY_KEY`, in the repository.

## Run a task on a schedule

`agent.schedule` turns on the scheduled agent, `plywood-schedule-agent`. It does the task on each run of the cron and opens a pull request from `plywood/agent/plywood-schedule-agent` when the task changes something. `cron` takes five fields. `task` takes up to 4000 characters of your own instruction. The workflow on the default branch supplies the task, so a pull request that edits it takes effect on merge.

A run that starts twice, by a retry or by hand within `agent.schedule.window` minutes, joins the first run. The scheduled agent holds no relay key.

## Read a run's trigger

Each run leaves a record on the chant workspace ledger that names the trigger (`alert`, `apply-failed` or `schedule`), the facts the run took, the stack, the window, and the pull request or commit it made. An alert's record also names each alert's source and id. A run over `agent.max_runs` is recorded as `stopped`, and the alerts that arrived over the limit start nothing later.

## Settings come from the default branch

Every agent reads its settings and limits from the default branch. A pull request that raises `agent.max_runs` takes effect on merge.
