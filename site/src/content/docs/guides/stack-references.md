---
title: 'Order stacks by their references'
description: 'A stack that reads another''s outputs updates after it.'
needs: [plywood#1, chant#4541, TBD-stackref-waves, TBD-chant-product-pipeline]
draft: true
---

A `StackReference` makes one stack read another's outputs:

```ts
const net = new pulumi.StackReference("acme/network/prod");
const vpcId = net.getOutput("vpcId");
```

plywood reads each stack's references from its last export and orders the waves by them, so `network/prod` updates before the stacks that read it. The note flags each preview that reads another stack's outputs.
