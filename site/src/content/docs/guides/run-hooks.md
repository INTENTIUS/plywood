---
title: 'Run your commands around a preview and an update'
description: 'List commands under ci.hooks in chant.workspace.json to run before and after each preview and each update, and hold a wave for an approval when one fails.'
---

Your own scripts run in the job that already previews or updates each stack, by the rules of chant's stage hooks. The checks `plywood check` runs live in the same block, so one file holds them all.

## The ci.hooks block

Each entry under `ci.hooks` in `chant.workspace.json` names a moment and the steps to run there:

```json
{
  "ci": {
    "hooks": {
      "before": {
        "plan": [{ "name": "esc", "command": ["sh", "-c", "esc env get acme/{target} --value json > esc.json"], "perRun": true }]
      },
      "after": {
        "plan": [{ "name": "verify", "command": ["sh", "-c", "./scripts/verify-plan.sh"], "perRun": true, "targets": ["*-prod"], "onFailure": "approve" }],
        "apply": [{ "name": "smoke", "command": ["./scripts/smoke.sh"] }]
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `command` | the argv to run from the repository's root; `["sh", "-c", "..."]` runs a shell line |
| `name` | the name in the log and the note; the command when unset |
| `perRun` | `true` runs the entry once for each stack it matches; unset, once for the job |
| `targets` | the stacks it runs for, as patterns over their component names (`shop/prod` is `shop-prod`, as `plywood.component.ts` names it); every stack when unset |
| `onFailure` | `"fail"`, the default, or `"approve"` |

Then run `plywood ci` (or `plywood init`) and commit the files it writes. Merge them, and later changes run the entries.

## Moments

| Moment | Runs |
|---|---|
| `before.observe` | before the stack is read |
| `before.plan` | before the preview |
| `after.plan` | after the preview, with `{plan}` and `CHANT_PLAN` naming a file that holds the stack's plan |
| `after.gate` | once the gate has decided |
| `before.apply` | before the update |
| `after.apply` | after the update |
| `check` | in `plywood check`, before any preview |

| Job | Runs |
|---|---|
| preview, and `/plywood preview` | `before.observe`, `before.plan` and `after.plan`, for each stack the change reaches |
| `/plywood up` with `apply.when: pull-request` | every moment, for the stacks it updates |
| each wave job on merge | every moment, for the wave's stacks |
| check | `check` |

Each entry gets the job's environment, and chant adds `CHANT_HOOK`, the moment, such as `before-plan`. A `perRun` entry also gets `CHANT_TARGET` and `{target}`. `CHANT_RUNS` and `{runs}` name a JSON file listing the stacks, and a wave job sets `CHANT_WAVE` and `{wave}`. In a preview `CHANT_TARGET` holds the stack's component name (`shop-prod`), and in a wave job the stack (`shop/prod`).

## Failures

| `onFailure` | A non-zero exit |
|---|---|
| `"fail"`, the default | stops the stage, and the entries after it do not run. Before an update, nothing in the wave updates. After an update, the job fails though the stacks have updated |
| `"approve"` | holds the wave at its gate for an approval of its plans with [`plywood approve`](/plywood/guides/approve-a-wave/). The entries after it still run |

chant refuses `"approve"` at `after.apply` and `after.gate`, and `plywood ci` prints chant's reason.

## Read at base

| Job | Reads `ci.hooks` at |
|---|---|
| a pull request's preview and update | the target branch |
| a wave job on merge | the merge's first parent, from `.chant/op-waves/pulumi-up.spec.json`, where `plywood ci` copies them |

A change therefore cannot add, edit or remove an entry its own jobs run, nor drop an `approve` entry to skip the gate. Run `plywood ci` after each edit to `ci.hooks`, so the waves spec carries the same entries as the preview.

## Tools in the image

Each entry runs in the job's image. Build [your own image](/plywood/guides/run-in-a-prepared-image/) when one needs a tool plywood's image lacks.
