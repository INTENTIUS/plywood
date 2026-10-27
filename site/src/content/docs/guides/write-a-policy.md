---
title: 'Write a policy'
description: 'A Rego rule over the change set denies a preview or holds it for a person.'
needs: [plywood#13, chant#4541, chant#4550]
draft: true
---

plywood switches on chant's [gate policy](https://intentius.io/chant/guide/gate-policy/). Policies are Rego rules that conftest or OPA runs over the change set. plywood reads them from the base branch.

```rego
package plywood

deny contains msg if {
  some e in input.members[_].entries
  e.op == "delete"
  startswith(e.type, "aws:s3/bucket")
  msg := sprintf("deletes bucket %s", [e.urn])
}
```

```yaml
policy:
  rego: policy/
```

A `deny` refuses the preview, and a `hold` waits for a person. [Override a denial](/plywood/guides/override-a-denial/).
