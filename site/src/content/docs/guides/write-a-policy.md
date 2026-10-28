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

Each entry of `input.changeSet.entries` is one change a preview proposes, with its `member`, `address` (the URN), `type` and `action`.

| Rule name | Effect |
|---|---|
| `deny`, `deny_<name>` | refuses the preview |
| `hold`, `hold_<name>` | waits for a person; needs `policy.engine: opa`, since conftest runs only deny and warn rules |
| `warn`, `warn_<name>` | a note line |

A denied Rego rule is `<package>.<rule>`, such as `plywood.deny_bucket_delete`. [Override a denial](/plywood/guides/override-a-denial/).

## Allow only listed provider packages

`policy.providers` lists the provider packages a stack may use. `plywood init` writes the list as a rule and as a CrossGuard pack:

```yaml
policy:
  rego: policy
  providers: [aws, random]
  packs:
    - { dir: policy/plywood-providers, config: policy/plywood-providers.json }
```

`policy/plywood_providers.rego` holds the rule.

```rego
package main

import rego.v1

allowed := {"aws", "random"}

deny_provider_package contains msg if {
	some e in input.changeSet.entries
	e.lexicon == "pulumi"
	e.action in {"create", "update", "replace"}
	p := package_of(e.type)
	not p in allowed
	msg := sprintf("%s uses the provider package %s, which policy.providers does not list", [e.address, p])
}
```

A resource's package is the first part of its type: `aws` for `aws:s3/bucket:Bucket`. A provider resource such as `pulumi:providers:aws` counts as the package it provides. Pulumi's own `pulumi:` types are left alone. A component's type has your own package name, so list that too. A delete never denies. The rule lands in the `policy.namespace` package when you set one, and `main` otherwise.

The pack is `policy/plywood-providers`, with the same check as a mandatory policy. Its list is `policy/plywood-providers.json`. Run `npm install` in the pack's directory and list the pack under `policy.packs` with that config. Every preview and update then runs it. Run `plywood init` again after you change `policy.providers`, and both files are rewritten.
