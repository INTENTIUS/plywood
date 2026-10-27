---
title: 'Approvals runbook'
description: 'The people who approve each stack, and the reasons an approval stops counting.'
needs: [plywood#7, chant#4541, chant#4550]
draft: true
---

plywood switches on chant's [approval rules](https://intentius.io/chant/guide/approval-rules/).

## Who may approve

`.chant/trust.json` maps roles to people, and `plywood.yml` maps stacks to roles:

```yaml
approval_rules:
  "shop/prod-*": { role: platform, quorum: 2 }
  "*": { role: developers }
```

Both files are read at base. The author of a pull request never counts toward its own quorum.

## An approval that no longer counts

| The wave says | Cause | Next step |
|---|---|---|
| preview moved | the preview changed after the approval | approve the new digest |
| approval spent | the approval was used by an earlier update | approve again |
| quorum short | fewer approvers than the rule asks | ask another approver |
| signer unknown | the key is missing from `allowed_signers` | add it in a reviewed pull request |
