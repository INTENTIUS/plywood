---
title: 'Threat model'
description: 'The reach of each job, starting with the preview job that runs the pull request''s program.'
needs: [plywood#1, chant#4541, TBD-pulumi-cloud-token, TBD-chant-product-pipeline]
draft: true
---

A Pulumi preview runs the program, so the preview job runs code from the pull request.

| Job | Runs | Holds | Never holds |
|---|---|---|---|
| preview | the pull request's program | the preview identity, read-only | the update identity, signing keys |
| up | the merged program | the update identity | signing keys |
| drift | the default branch's program | the preview identity | the update identity |
| review agent | no program | a read token | any cloud identity |

The OIDC trade happens before checkout, and later steps drop the token variables. Policy, approvers and pins are read at base, so a pull request cannot change the rules that judge it. Identities are chant's [cloud identities](https://intentius.io/chant/guide/security-cloud-identities/).
