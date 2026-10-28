---
title: 'Threat model'
description: 'The reach of each job, starting with the preview job that runs the pull request''s program.'
---

A Pulumi preview runs the program, so the preview job runs code from the pull request.

| Job | Runs | Holds | Never holds |
|---|---|---|---|
| preview | the pull request's program | the preview identity, read-only | the update identity, signing keys |
| up | the merged program | the update identity | signing keys |
| drift | the default branch's program | the preview identity | the update identity |
| review | the model command, on the diff | the model's key (`review.key_env`) alone; a second job posts its note | a forge write token, any cloud identity |

The preview job trades its forge OIDC token before the program is checked out, and every later step starts without the token request variables. On Pulumi Cloud the preview job and the update job each get their own access token, and one identity for both is refused. Policy, approvers and pins are read at base, so a pull request cannot change the rules that judge it. Identities are chant's [cloud identities](https://intentius.io/chant/guide/security-cloud-identities/).
