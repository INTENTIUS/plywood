---
title: 'A stack per pull request'
description: 'Each open pull request gets its own stack from a template stack''s config, destroyed and removed when it closes.'
needs: [plywood#15, chant#4541, chant#4550]
draft: true
---

plywood switches on chant's [pull request environments](https://intentius.io/chant/guide/pr-environments/) with Pulumi review stacks.

```yaml
review_stacks:
  template: shop/dev
  name: pr-{number}
```

An opened pull request gets its own stack `pr-42` from the template's config, and plywood updates it. When it closes, plywood runs `pulumi destroy --yes` and `pulumi stack rm`. Only stacks named by the pattern are ever destroyed.

Pulumi Cloud shows review stacks in its console like any other stack.
