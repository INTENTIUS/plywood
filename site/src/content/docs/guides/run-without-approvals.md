---
title: 'Run without approvals'
description: 'Sandbox stacks can update on merge with no approval.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

```yaml
gate: never
```

The same key works per stack:

```yaml
stacks:
  shop/sandbox:
    gate: never
```

With `gate: never` the merge is the approval. Waves still run in order, and policy still runs on every preview. `gate: destroy` waits only for a wave whose preview deletes or replaces a resource.
