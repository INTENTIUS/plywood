---
title: 'Re-preview from a comment'
description: 'A /plywood preview comment previews the pull request''s head again and updates the note.'
needs: [plywood#28]
draft: true
---

Comment on the pull request:

```text
/plywood preview
```

One job previews every stack the change reaches at the pull request's head. A second job then updates the note and the `plywood/preview` status. Use it after a change outside the repository, such as a new ESC value.

The comment also takes the preview's flags. `--target <urn>` narrows the preview to that resource and can repeat. `--target-dependents` adds the resources that depend on the targets. `--refresh` reads the cloud first.

```text
/plywood preview --target urn:pulumi:prod::shop::aws:sqs/queue:Queue::events --refresh
```

The note lists the URNs of each narrowed stack. A stack name in the comment narrows nothing, and the job previews every stack the change reaches.

A push to the target branch can leave a note behind. A job on that push then adds a stale line to the note with this comment in it, and the `plywood/preview` status waits again. Comment to preview against the new tip.

The preview job holds a read token only, and drops it before your program runs. On GitHub only someone with write access to the repository can start it. Forgejo has no such check. On GitLab, a note starts nothing: run a pipeline of the target branch with the variable `CHANT_PREVIEW_PR` holding the merge request's number.

`plywood ci` writes the two jobs into the workflow once your chant has them. Run it again after you upgrade.
