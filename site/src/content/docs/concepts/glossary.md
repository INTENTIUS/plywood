---
title: 'Glossary'
description: 'Pulumi''s words as plywood uses them, and plywood''s few additions.'
---

plywood uses Pulumi's words with Pulumi's meanings. The additions are at the end.

## Pulumi's words

| Term | Meaning |
|---|---|
| program | your Pulumi code, in any language Pulumi supports |
| project | the directory with `Pulumi.yaml` |
| stack | an instance of a project; the unit plywood previews, approves, locks and updates |
| stack config | `Pulumi.<stack>.yaml`, read as it is |
| preview | `pulumi preview`; the note shows it and a gate binds its digest |
| up | `pulumi up`; also the name of plywood's update stage |
| URN | a resource's address in notes, targets, locks and drift issues |
| component | a component resource; the note groups its children under it |
| backend | where state lives: Pulumi Cloud, a self-managed store, or plunge |
| stack export | the deployment JSON from `pulumi stack export` |
| stack reference | one stack reading another's outputs with `StackReference` |
| policy pack | CrossGuard policies, run in the preview job |
| ESC environment | config and secrets a stack imports from Pulumi ESC; stock Pulumi resolves them on the Pulumi Cloud backend, and chant keeps no copy |
| review stack | a stack per pull request |

## plywood's additions

| Term | Meaning |
|---|---|
| wave | a group of stacks behind one gate |
| canary stack | the first wave |
| preview digest | the hash an approval binds; chant's plan digest over the change set |
| gate | the point where a wave waits for an approval |
| ledger | chant's workspace ledger on your repository's `chant/lifecycle` branch; chant defines its record format, and approvals, overrides, gate decisions and run records are its rows ([chant ledger](https://intentius.io/chant/cli/ledger/)) |
| snapshot | a stack's export after an update, stored by chant under `refs/chant/snapshots` |

## plunge

plunge is the Pulumi fork from the team behind plywood. Its drop-in CLI keeps one record per resource and writes `plunge-stack` and `plunge-urn` markers on each cloud object. [intentius.io/plunge](https://intentius.io/plunge/).

## chant

[chant](https://intentius.io/chant/) is the runtime under plywood and terragucci. The gates and the ledger are chant's, and so are change sets and target locks. chant also runs the product pipeline that posts plywood's notes.
