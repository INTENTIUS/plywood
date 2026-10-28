---
title: 'Run without approvals'
description: 'Sandbox stacks can update on merge with no approval.'
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

With `gate: never` a wave updates on merge without waiting at its gate. Waves still run in order, and policy still runs on every preview: a deny still refuses, and a hold still makes the wave wait for a person.

A wave takes the strictest gate of its stacks. `gate: on-destructive` is the default and holds a wave only when its preview deletes or replaces a resource. With `gate: always` every wave asks for an approval.
