---
title: 'The control repo'
description: 'One home for the policy and approvers of many repositories.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

A control repo is an ordinary repository that holds:

- `policy/`, the Rego rules and CrossGuard packs;
- `.chant/trust.json`, the roles and their people;
- `.chant/allowed_signers`, the keys for signed approvals;
- `pins.yml`, the Pulumi, plunge and image versions.

Each repository names it in `plywood.yml`, and reads it at the control repo's default branch. A change to the rules is a reviewed pull request on the control repo.
