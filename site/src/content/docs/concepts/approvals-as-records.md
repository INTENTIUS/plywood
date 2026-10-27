---
title: 'Approvals are records'
description: 'An approval is a row in the chant workspace ledger in your repository, bound to one preview digest.'
needs: [plywood#7, chant#4541, chant#4550]
draft: true
---

`plywood approve` records a row in the [chant workspace ledger](https://intentius.io/chant/cli/ledger/) on your repository's `chant/lifecycle` branch. The row holds the gate and the digest. It also names the approver and the time, and with `--sign` it carries an SSH signature.

Because the record lives in git:

- there is no service to run or back up;
- the forge's own permissions decide who can push a record;
- `git log chant/lifecycle` is an audit trail anyone with read access can check.

A wave reads the ledger when it runs. It updates only when a row approves its exact digest and that row is unspent.
