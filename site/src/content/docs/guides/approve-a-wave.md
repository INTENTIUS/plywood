---
title: 'Approve a wave'
description: 'plywood approve records an approval of one preview digest, and the wave''s next job updates the stacks it covers.'
---

A waiting wave's job stops with exit code 3 and prints its gate, its digest and the line that approves it:

```text
plywood: wave-2 waits for an approval. Approve the digest chant printed with 'plywood approve wave-2 --plan <digest>', then run plywood up --wave 2 again.
```

With `notify` set, the chat channel hears it too. Read the preview, then approve that digest:

```sh
npx plywood approve wave-2 --plan sha256:0a6f...
```

At a terminal plywood shows the plan and asks for the target's name before it records anything. `--yes` skips the question. plywood records the approval as a row in the [chant workspace ledger](https://intentius.io/chant/cli/ledger/), and chant's [gate decision](https://intentius.io/chant/guide/decision-points/) reads it. The scheduled resume job then starts the wave; `npx plywood resume --wave 2` or `npx plywood up --wave 2` starts it at once. Each approval counts once, for that digest only.

## Signed approvals

With `approval: sealed`, add `--sign`. The approval then needs an SSH key listed in `.chant/allowed_signers` at base, and CI jobs hold no such key.
