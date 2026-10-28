---
title: 'Drift checks with their own identities'
description: 'The drift job reads with the preview identity and names the writer of each drifted attribute.'
needs: [chant#4631, chant#4632]
draft: true
---

With `identity` in `plywood.yml`, each stack's drift job trades its OIDC token for the stack's preview identity before the checkout. No later step can ask for another token, so the read never holds the up identity.

Under `respond.drift: up` the update has a job of its own after the read. It starts only when the read found drift. That job holds the stack's up identity and runs in the stack's forge environment from `environments`. It runs `plywood up` for the waves holding the stack, each through its gate.

On GitHub and Forgejo the update job also holds `contents: write`, so `plywood up` there pushes its records to `chant/lifecycle` with the job token. The read keeps `contents: read`. GitLab sets no scopes per job: whether its job token may push is a project setting, so `plywood ci` asks for none there.

`drift.audit_log` names the CloudTrail to read each stack's writes from. Give `aws` or `aws:<region>` for every stack, or map stack globs to them:

```yaml
drift:
  schedule: "0 6 * * *"
  audit_log:
    "shop/*": aws:eu-west-1
```

`plywood drift` then names the writer of each drifted attribute. The answer comes from the known writes or from the CloudTrail entry. A tag the provider adds is a known write. An attribute neither explains is unattributed. A controller's write comes with the `ignoreChanges` line that keeps it out of the next update. The lines go in the output and in the stack's issue. The read uses the job's own credentials, so give the preview identity `cloudtrail:LookupEvents`.

`npx plywood audit-log unrecorded --audit-log aws --op pulumi-up --since <time>` lists the account's writes since that time that no recorded update made.
