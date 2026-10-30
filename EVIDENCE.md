# Evidence

What plywood has been checked against, and how. Updated with each release (see Releasing in AGENTS.md). The page is rendered by `just e2e render` from the scenario files in `e2e/scenarios`, the plunge list in `e2e/plunge-claims.ts` and the rows the bench recorded; do not edit the tables by hand.

## How it is verified

Each scenario runs on the e2e bench (`just e2e`), on chant's e2e harness: a local Forgejo, a runner and the floci emulator, with no real cloud. A scenario runs twice. The plain arm must pass. The BREAK arm changes one thing so the claim should fail, and the scenario counts only if the check catches it. A row is recorded only when the run's scan for real-cloud credentials was clean, and it names the commit, date, engine and floci digest it ran on.

## Scenarios

| Scenario | Claim | What it checks | What the BREAK arm changes | Status | Commit | Date |
|---|---|---|---|---|---|---|
| `pw-action` | `action/gated-replace` | A day-2 action waits for a second person's approval of its preview, then replaces its command resource once | After the approval, main changes the command's marker, so the preview the second call makes differs from the one approved: the request waits again (exit 3), nothing is replaced, and the run step's exit 0 and ok outcome must not hold. | not recorded yet |  |  |
| `pw-adopt` | `plunge/adopt-stock-stack` | A stock Pulumi stack moves onto plunge's records through plywood's adopt op, then updates through a pull request | the adopt Op points staging at a bucket with no versioning, lifecycle rule or public access block, which chant's bucket check and plunge's store refuse, so plywood-adopt must not stop at its gate. | last run: plain fail, break caught | `6802d298cf54` | 2026-10-30 |
| `pw-canary` | `wave/canary` | The canary stack updates in the first wave, and the next wave starts only after it ends, under the pull request's approval | main puts both prod stacks in one first wave, so no canary goes ahead of the other: the canary check must fail. | recorded, passing | `9e2dc493c1e1` | 2026-10-30 |
| `pw-disjoint` | `plunge/disjoint-updates` | Two pull requests that change different resources of one plunge stack update together | main takes locks.grain: stack before the pull requests open, so plywood locks the whole dev stack: the second update is held or runs after the first, and the together check must fail. | last run: plain fail, break caught | `9e2dc493c1e1` | 2026-10-30 |
| `pw-drift` | `drift/issue` | A queue changed by hand on floci gives one drift issue naming its URN and attribute | The change by hand sets the retention prod-us already has after the update, so nothing drifted, the drift job exits 0 and opens no issue: the drift-job step must fail. | last run: plain fail, break caught | `9e2dc493c1e1` | 2026-10-30 |
| `pw-moved-plan` | `plunge/saved-plan-moved` | A plunge update whose records moved after its preview is refused with chant's moved code | The update made elsewhere sets the value dev already has, so no record is written, nothing moves, and the merge's update applies: the moved check must fail. | last run: plain fail, break stalled | `9e2dc493c1e1` | 2026-10-30 |
| `pw-moved-preview` | `gate/moved-preview` | A push after the approval changes the preview, so the merged change waits at its wave's own gate | The push after the approval adds a notes file no stack reads, so the preview and its digest stay the same, the approval covers the merge and prod-us applies: the waits check must fail. | last run: plain pass, break missed | `e2401dd59e03` | 2026-10-30 |
| `pw-one-note` | `preview/one-note` | A change that reaches two stock Pulumi stacks gives one note, one group and one approval command | prod-eu also takes a fourth worker queue, so the two stacks take different changes and the note shows two groups: the one-group check must fail. | recorded, passing | `9e2dc493c1e1` | 2026-10-30 |

`pulumi-cloud/token` is a real-account run by the maintainer and stays out of the harness.

## plunge features

plywood's `engine: plunge` features rest on runs recorded on [plunge's evidence page](https://github.com/INTENTIUS/plunge/blob/main/EVIDENCE.md). A feature with no run listed waits on a plunge release.

| Feature | What it says | Run on plunge's page | Waits on |
|---|---|---|---|
| `markers-and-records` | markers on each resource and a record per resource | `plunge up` of `tests/plunge-corpus/aws-ts` on `plunge+file://` |  |
| `drift-per-resource` | drift read per resource with one provider read and no program run | `plunge drift --resource <urn> --stream` on three resources of the same stack |  |
| `concurrent-updates` | two updates to different resources of one stack run side by side, with no stack lock |  | plunge#6: its maintainer run, which the races lifecycle row on plunge's page records, is credited here once plunge#6 closes; the refresh fix is on plunge main, so it waits on the plunge release after 0.1.0 |
| `record-per-resource` | a record per resource with conditional writes in place of a stack lock |  | plunge#6, as concurrent-updates, and the plunge release after 0.1.0 |
| `per-resource-progress` | per-resource timings of each provider call and record write during up |  | plunge#55: a recorded plunge up --json with its timings; the timings are on plunge main, so it waits on the plunge release after 0.1.0 |
| `markers-ownership` | each resource's owner from its markers, and a graph read from records |  | plunge#40, closed on 2026-10-28 with its fix on plunge main after 0.1.0: the maintainer run of plunge graph --json is credited here once a plunge release after 0.1.0 carries it |
