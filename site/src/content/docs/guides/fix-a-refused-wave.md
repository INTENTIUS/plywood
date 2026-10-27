---
title: 'Fix a refused wave'
description: 'Each refusal names its cause and the command that clears it.'
needs: [plywood#1, chant#4541, TBD-chant-exit-codes, TBD-chant-product-pipeline]
draft: true
---

A refused wave updates nothing. Its job prints the refusal and the command to run.

| Refusal | Cause | Clear it |
|---|---|---|
| preview moved | the preview at update time differs from the approved digest; on plunge, a record moved after the saved plan | approve the new digest |
| approval spent | the approval was used | approve again |
| policy denied | a Rego rule or a CrossGuard policy denied the preview | change the program, or `plywood override` |
| lock held | another pull request holds a resource or stack this one changes | wait for it to merge or close, or `/plywood unlock` on it |

Each refusal has its own exit code from chant's one table. [Exit codes](/plywood/reference/exit-codes/).
