---
title: 'Re-preview from a comment'
description: 'A /plywood preview comment previews the pull request''s head again and replaces the note.'
needs: [plywood#6, chant#4541, chant#4550]
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

Use it after a change outside the repository, such as a new ESC value. Comments come through chant's [pull request hooks](https://intentius.io/chant/guide/pull-request-hooks/).
