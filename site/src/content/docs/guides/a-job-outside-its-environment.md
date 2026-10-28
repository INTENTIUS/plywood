---
title: 'A job outside its environment'
description: 'Exit code 9: the job ran somewhere plywood.yml does not give the stack.'
needs: [chant#4624]
draft: true
---

Each update job checks where it runs before it touches a stack. Its forge environment must be the one `environments` names, and its branch and runner must match `plywood.yml` too. On a mismatch nothing runs and the job exits 9, `misplaced`. chant's message names the difference, and plywood adds the way out:

```text
plywood: The job ran outside the forge environment, branch or runner plywood.yml gives this stack, and chant's job guard named the difference above, so nothing ran. Run it from that branch on that runner, or change environments and runners in plywood.yml and run 'plywood ci' again.
```

A workflow copied by hand from another repository, or edited after `plywood ci` wrote it, is the usual cause. Run `npx plywood ci` again and commit the files it writes.

With a chant that has no job guard, plywood still passes 9 through unchanged, so a caller that tests exit codes sees the same number either way.
