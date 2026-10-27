---
title: 'Have an agent review a pull request'
description: 'A model compares the pull request''s description with its previews and posts one note.'
needs: [plywood#1, chant#4541, chant#4544, TBD-chant-product-pipeline]
draft: true
---

plywood switches on chant's [review agent](https://intentius.io/chant/guide/review-agent/).

```yaml
review:
  agent: true
```

The review job compares the description with the diff and the change set. It posts one note with the risk and any mismatch between the stated intent and the previews. The job holds a read token on every forge, and approval stays with people.
