---
title: 'Approvals runbook'
description: 'The people who approve each stack, and the reasons an approval stops counting.'
---

plywood switches on chant's [approval rules](https://intentius.io/chant/guide/approval-rules/).

## Who may approve

`.chant/trust.json` maps roles to people, and `plywood.yml` maps stacks to roles:

```yaml
approval: sealed
approval_rules:
  "shop/prod-*": { role: platform, quorum: 2 }
  "*": { role: developers }
```

Both files are read at base. A rule that names a role counts only proven approvals. Pair it with `approval: sealed` for signed approvals or `approval: pr-review` for the forge's reviews. `plywood config check` warns when `approval` is left at `ledger`. `roles` takes a list, any of which counts. The author of a pull request never counts toward its own quorum.

## An approval that no longer counts

| Cause | Next step |
|---|---|
| the preview changed after the approval | approve the new digest |
| a wave already updated under that approval | approve again |
| fewer approvers than the rule asks | ask another approver |
| the key is missing from `.chant/allowed_signers` at base | add it in a reviewed pull request |
