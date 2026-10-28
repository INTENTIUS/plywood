---
title: 'Update a stack before it merges'
description: 'Opt in with apply.when, then a /plywood up comment updates the approved preview from the pull request.'
---

plywood switches on chant's [apply before merge](https://intentius.io/chant/guide/apply-before-merge/).

```yaml
apply:
  when: pull-request
```

Approve the preview, then comment:

```text
/plywood up
```

The update job runs the pull request's preview from its head in one job, under the pull request's gate. Before it runs, it asks the forge four checks:

| Check | Passes when |
|---|---|
| `approved` | the head has an approval |
| `mergeable` | the forge says the pull request merges as it stands |
| `undiverged` | the head contains the target branch's tip |
| `checks` | every check passed |

`apply.requires` lists fewer of them. Merge once the update is done; nothing updates again on merge.

The pull request holds its locks for its whole life, and lets go of them when it merges or closes.
