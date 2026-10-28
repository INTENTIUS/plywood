---
title: 'Exit codes'
description: 'plywood uses chant''s exit-code table, which terragucci shares.'
---

plywood exits with the codes of chant's one exit-code table and passes each through unchanged. terragucci uses the same table, and both engines map onto it.

| Code | Name | Meaning |
|---|---|---|
| 0 | `done` | the stage finished, or had nothing to do |
| 1 | `failed` | something broke and no approval changes it; usage and config errors too |
| 2 | `drift` | a drift check found drift |
| 3 | `waiting` | a gate, a review or an earlier wave waits for a person |
| 4 | `moved` | the approved preview or saved plan no longer matches the one that would apply, so nothing applied |
| 5 | `held` | another run or open pull request holds a lock on a stack or resource the change touches |
| 6 | `superseded` | a newer push applies in its place |
| 7 | `denied` | policy denied the preview and no override counts |
| 8 | `declined` | a decision point got an answer the gate does not pass on |

Pulumi's own codes never pass through raw. A mandatory CrossGuard violation (Pulumi's 5) is `denied` and changes under `--expect-no-changes` (Pulumi's 7) are `drift`. Every other nonzero Pulumi code is `failed`. plunge's exit 40, a saved plan whose records moved, is `moved`, as is a stock preview that no longer matches its approved shape.
