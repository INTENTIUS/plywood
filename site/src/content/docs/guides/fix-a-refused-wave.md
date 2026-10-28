---
title: 'Fix a refused wave'
description: 'Each refusal names its cause and the command that clears it.'
---

A refused wave updates nothing. Its job prints the refusal and the command to run.

| Refusal | Exit | Cause | Clear it |
|---|---|---|---|
| waiting | 3 | the wave's gate waits for an approval | `plywood approve wave-<k> --plan <digest>`, then `plywood up --wave <k>` |
| moved | 4 | the preview at update time differs from the approved digest; on plunge, another update wrote a record the saved plan read | preview again and approve the new digest |
| held | 5 | another update or pull request holds a lock on a resource or stack this update touches | wait for a running update to end, or `/plywood unlock` on the pull request that holds it |
| superseded | 6 | a newer push stands in for this one | nothing: the newer run updates the stacks |
| denied | 7 | a Rego rule or a CrossGuard policy denied the preview | change the program, or `plywood override` |
| declined | 8 | an approver declined the change | push a new change and preview it |

The codes are chant's, passed through unchanged. [Exit codes](/plywood/reference/exit-codes/).
