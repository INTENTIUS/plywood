---
title: 'Override a denial'
description: 'plywood override records a person''s reasoned approval of one denied preview. It is spent once the update runs.'
needs: [plywood#7, chant#4541, chant#4550]
draft: true
---

```sh
npx plywood override pr-12 --rule deletes-bucket --reason "retiring the old site bucket"
```

The override names the rule and the digest, and it is a row in the [chant workspace ledger](https://intentius.io/chant/cli/ledger/). Only people in the `override` role of `.chant/trust.json` may record one. It covers one preview, and the update spends it.
