---
title: 'Estimate cost and hold a wave on it'
description: 'A command you name prices each preview; the note shows the monthly change, and a wave waits for an approval above an amount you set.'
needs: [chant#5334, chant#5341]
draft: true
---

plywood prices nothing itself. You name a command that reads a stack's preview JSON and prints its monthly cost, and chant runs it on every preview and wave. The `cost` key of `plywood.yml` holds it:

```yaml
cost:
  command: ./tools/price-preview {planJson}
  approve_above: 100
  currency: USD
```

`{planJson}` is the preview JSON of the stack (`pulumi preview --json`), and `{target}` is the stack. The command prints one JSON object on standard output:

```json
{ "monthlyDelta": 42.5, "monthlyTotal": 310, "pastMonthlyTotal": 267.5, "currency": "USD" }
```

Only `monthlyDelta` is required. For a command that prints Infracost's JSON, set `format: infracost`. The command runs once per stack whose preview changes something, and a command that fails or prints something unreadable leaves that stack unpriced.

Run `plywood ci` after you set it.

## In the note

The preview note lists each stack's monthly change and the sum, and names each stack the command could not price. A stack with no change is not priced. A failed estimate never fails the preview.

Rego rules read the same figures as `input.cost`: `input.cost.monthlyDelta`, `input.cost.members` and `input.cost.unestimated`. In a wave's policy run, `input.cost.member` holds that stack's own. A `deny_` rule over `input.cost` denies a change by amount.

## Hold above an amount

With `approve_above`, a preview whose monthly change is over it needs an approval of its own digest, and a wave over it waits for a person whatever its gate says. A stack the estimator could not price counts as over. The cost is part of the wave's digest, so an approval at one cost does not apply at another. The hold is recorded on the ledger as any other gate is, and `plywood approve` answers it.

The amount only adds approvals. A change under it still follows its gate, and nothing here lets an update run without one. Without `approve_above` the note shows the estimate and holds nothing.

## No estimator ships with plywood

Infracost reads Terraform plans, and Pulumi previews have no price source of their own. A script that looks up each resource type in your own price table, or calls a pricing service your team uses, is enough, as long as it prints the figures above.
