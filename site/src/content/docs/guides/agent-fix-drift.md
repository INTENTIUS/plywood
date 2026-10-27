---
title: 'Have an agent fix drift'
description: 'The agent opens a pull request that brings the program back in line with the drift found. A person approves the update.'
needs: [plywood#19]
draft: true
---

```yaml
agent:
  drift: true
```

When the drift job opens an issue, the agent changes the program to match the live value. It opens a pull request with the change. The pull request gets its own preview note, and a person approves it like any other.
