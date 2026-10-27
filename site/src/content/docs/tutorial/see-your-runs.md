---
title: 'See your runs'
description: 'Read the tutorial''s runs and approvals with plywood audit and chant query.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

Every step of the tutorial left a row in the chant workspace ledger of `tutor/shop`.

```sh
npx plywood audit --since 1h
```

```text
14:02  pr-1     preview   sha256:71d2...  4 stacks
14:05  pr-1     approve   sha256:71d2...  tutor
14:06  wave-1   up        shop/dev        ok
14:09  wave-2   approve   sha256:0a6f...  tutor
```

`chant ledger` reads one table with typed filters ([chant ledger](https://intentius.io/chant/cli/ledger/)):

```sh
npx chant ledger gates --where gate=wave-2
```

The same rows answer SQL:

```sh
npx chant query "SELECT member, count(*) FROM runs WHERE kind = 'up' GROUP BY member"
```

behold is chant's console. It reads the same ledger and shows each stack's resources with their drift. [See your stacks in behold](/plywood/guides/see-your-estate-in-behold/).
