---
title: 'Resources registered inside apply()'
description: 'A preview cannot run an apply() whose input is unknown. The note lists those components as may register at up.'
needs: [plywood#1, chant#4541, chant#4548, chant#4550]
draft: true
---

Pulumi runs an `apply()` callback once its input is known. In a preview, an input such as a new VPC's ID is unknown, so resources created inside the callback do not appear.

```ts
const vpcParam = vpc.id.apply((id) => new aws.ssm.Parameter("vpc-id", { value: id }));
```

plywood lists the enclosing stack under its own row:

```text
shop/dev   may register at up: resources created inside apply() calls
```

The row is part of the preview digest, so an approval covers it. Moving the resource out of the callback, with the output passed as an input, makes it show in every preview.
