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

One job previews every stack the change reaches at the pull request's head. A second job then updates the note and the `plywood/preview` status. Use it after a change outside the repository, such as a new ESC value. The comment takes no stack and no flags.

The preview job holds a read token only, and drops it before your program runs. On GitHub only someone with write access to the repository can start it. Forgejo has no such check. On GitLab, a note starts nothing: run a pipeline of the target branch with the variable `CHANT_PREVIEW_PR` holding the merge request's number.

`plywood ci` writes the two jobs into the workflow once your chant has them. Run it again after you upgrade.
