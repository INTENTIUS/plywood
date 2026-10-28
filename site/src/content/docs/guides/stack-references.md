---
title: 'Order stacks by their references'
description: 'A stack that reads another''s outputs updates after it.'
---

A `StackReference` makes one stack read another's outputs:

```ts
const net = new pulumi.StackReference("acme/network/prod");
const vpcId = net.getOutput("vpcId");
```

plywood reads each stack's references from its last export and orders the waves by them, so `network/prod` updates before the stacks that read it. A stack's first update has no export yet, and outputs that are all secret show no reference, so give that order by hand:

```yaml
waves:
  canary: [app/dev]
  after:
    app/prod: [network/prod]
```

`canary` puts its stacks in a first wave of their own. `plywood init` prints each order it found, and each reference to a stack this repository does not list.
