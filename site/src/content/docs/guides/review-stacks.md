---
title: 'A stack per pull request'
description: 'Each open pull request gets its own stack from a template stack''s config, destroyed and removed when it closes.'
---

plywood switches on chant's [pull request environments](https://intentius.io/chant/guide/pr-environments/) with Pulumi review stacks.

```yaml
review_stacks:
  template: shop/dev
  name: pr-{number}
  ttl: 72h
```

An opened pull request gets its own stack, `shop/pr-42`, made from the template's config. Each push previews it, and its update waits for an approval of that preview's digest:

```sh
npx plywood approve review --pr 42 --plan <digest>
```

plywood runs `pulumi destroy --yes` and `pulumi stack rm --yes` on the review stack once the pull request closes. A stack whose last update is older than `ttl` goes the same way. `name` is `pr-{number}` or `pr-{number}-<suffix>`, and only stacks named so are ever destroyed. Each review stack made and removed is a row in `plywood audit review-stacks`.

Pulumi Cloud shows review stacks in its console like any other stack.
