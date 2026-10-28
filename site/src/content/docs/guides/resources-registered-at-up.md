---
title: 'Resources registered inside apply()'
description: 'A preview cannot run an apply() whose input is unknown. The note lists the component resources that may register more at up.'
---

Pulumi runs an `apply()` callback once its input is known. In a preview, an input such as a new VPC's ID is unknown, so resources created inside the callback do not appear.

```ts
class Network extends pulumi.ComponentResource {
  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("acme:index:Network", name, {}, opts);
    const vpc = new aws.ec2.Vpc("vpc", { cidrBlock: "10.0.0.0/16" }, { parent: this });
    vpc.id.apply((id) => new aws.ssm.Parameter("vpc-id", { type: "String", value: id }, { parent: this }));
  }
}
```

A component whose subtree in the preview holds an unknown value, or a create or replace, may be waiting on that value to register children. The note lists it under its stack:

```text
| Member | Component resource      | Resource                  | At up                |
| shop   | acme:index:Network main | any resource it registers | may register at up   |
```

A resource that the stack's last export holds and the preview leaves out gets its own row: `missing from the preview, and may register at up`. A delete under such a component reads `planned to delete, and may register again at up`.

A resource created inside an `apply()` directly under the stack, with no component around it, has no row: when its input is unknown the preview shows it as a plain delete. Put it inside a component, or move it out of the callback with the output passed as an input, so the preview shows it.
