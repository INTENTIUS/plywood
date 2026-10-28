---
title: 'Merge once the update is done'
description: 'apply.merge: auto merges the pull request after /plywood up updates it.'
needs: [chant#4636]
draft: true
---

With updates before merge, a person merges once `/plywood up` is done. `apply.merge: auto` has the update job merge the pull request itself:

```yaml
apply:
  when: pull-request
  merge: auto
  merge_token_env: PLYWOOD_MERGE_TOKEN
  merge_method: squash
```

Once every stack updated and the record is on the ledger, the job reads the pull request again. It merges only when the pull request is still open at the commit that updated, so a push after the update is never merged without its own update.

The merge uses the token in the variable `merge_token_env` names, and no other: a repository secret of that name on GitHub and Forgejo, a protected CI/CD variable on GitLab. Give it a token that may merge under your branch protection. `merge_method` is `merge`, `squash` or `rebase`; the forge's default when you leave it out.

A merge the forge refuses, such as for branch protection, a new push or a conflict, leaves the update recorded and posts the reason on the pull request in one comment, edited on the next try. The update never runs again for the merge. `npx plywood up --pr <n>` merges the same way when you run it by hand.
