---
title: 'Override a denial'
description: 'plywood override records a person''s reasoned approval of one denied preview. It is spent once the update runs.'
---

```sh
npx plywood override shop/prod --rule main.deny_public_bucket --reason "retiring the old site bucket"
```

The override names the stack and each rule that denied it, with a reason. A Rego rule is `<package>.<rule>` and a CrossGuard policy is `crossguard.<pack>.<policy>`, as the denial lists them. The override binds the preview's digest and those rules. It is a row in the [chant workspace ledger](https://intentius.io/chant/cli/ledger/). Only a person listed in `.chant/overriders` at base, one per line, may record one that counts. Under `approval: sealed` it needs `--sign`. Each covers one preview, and the update spends it.
