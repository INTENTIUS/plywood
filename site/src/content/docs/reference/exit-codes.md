---
title: 'Exit codes'
description: 'plywood uses chant''s exit-code table, which terragucci shares.'
needs: [plywood#7, chant#4541, chant#4553, chant#4550]
draft: true
---

plywood exits with the codes of chant's one exit-code table. terragucci uses the same table, and both engines map onto it.

| Code name | Meaning |
|---|---|
| ok | the stage finished |
| failed | a command failed |
| moved | the preview or saved plan moved after the approval |
| waiting | a gate waits for an approval |
| denied | policy denied the preview |
| locked | another pull request holds a lock |

plunge's exit 40, a saved plan whose records moved, maps to `moved`, as does a stock preview that no longer matches its approved shape.
