---
title: 'Re-preview from a comment'
description: 'A /plywood preview comment previews the pull request''s head again and replaces the note.'
needs: [TBD-preview-comment-job]
draft: true
---

Comment on the pull request:

```text
/plywood preview
```

The preview job runs on the pull request's head and replaces the note in place. Name one stack to preview only that stack:

```text
/plywood preview shop/dev
```

The comment takes one stack at most and no flags. Use it after a change outside the repository, such as a new ESC value.
