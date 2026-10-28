---
title: 'Write a policy'
description: 'A Rego rule over the change set denies a preview or holds it for a person.'
---

plywood switches on chant's [gate policy](https://intentius.io/chant/guide/gate-policy/). Policies are Rego rules that conftest or OPA runs over the change set. plywood reads them from the base branch.

```rego
package plywood

deny_bucket_delete contains msg if {
  some e in input.changeSet.entries
  e.action == "delete"
  startswith(e.type, "aws:s3/bucket")
  msg := sprintf("deletes bucket %s", [e.address])
}
```

```yaml
policy:
  rego: policy
```

Each entry of `input.changeSet.entries` is one change a preview proposes, with its `member`, `address` (the URN), `type` and `action`. | Rule name | Effect |
|---|---|
| `deny`, `deny_<name>` | refuses the preview |
| `hold`, `hold_<name>` | waits for a person; needs `policy.engine: opa`, since conftest runs only deny and warn rules |
| `warn`, `warn_<name>` | a note line |
 A denied Rego rule is `<package>.<rule>`, such as `plywood.deny_bucket_delete`. [Override a denial](/plywood/guides/override-a-denial/).
