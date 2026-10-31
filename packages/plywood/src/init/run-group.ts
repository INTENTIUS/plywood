/**
 * A concurrency group for the workflows that record and apply on merge on
 * Forgejo, so one merge does not cancel another's jobs (plywood#51).
 *
 * Forgejo gives a run of a workflow with no workflow-level `concurrency:` a
 * group of its own per ref, workflow and event, and cancels the run in
 * progress when a push or a pull request update starts another (Forgejo's
 * `ConfigureActionRunConcurrency`, services/actions/workflows.go, v16: with no
 * `cancel-in-progress` set, a push or a pull request sync cancels). A job-level
 * `concurrency:`, which the pull request workflow's record job has, does not
 * count. chant writes the waves workflow and the pull request workflow with
 * no workflow-level group, so two merges a few seconds apart cancelled the
 * first merge's wave and record jobs while they ran, which can leave a stack
 * half updated with nothing recorded.
 *
 * Both fields of the block are expressions the Forgejo runner evaluates, and
 * a group with `cancel-in-progress: false` only queues runs that share it:
 *   - waves: one group per event and commit, so a merge's run is never
 *     cancelled by another commit's, and runs of other commits overlap as
 *     chant's ledger allows.
 *   - pull request workflow: one group per run, except that a pull request's
 *     runs share a group and cancel each other, as Forgejo already did for a
 *     new push to the pull request. A push to main (the record job) and a
 *     comment never cancel anything.
 *
 * GitHub cancels nothing without a group, so its files are left as chant
 * wrote them. GitLab jobs are not `interruptible`, so auto-cancel of
 * redundant pipelines never cancels a pipeline that has started one.
 */
import type { ForgeKind } from "../chant-product";

const TOP_CONCURRENCY = /^concurrency:/m;
const TOP_JOBS = /^jobs:/m;
const TOP_NAME = /^name:\s*(.+?)\s*$/m;

/** What a run's group is keyed on: the commit (the waves) or the pull request (the pull request workflow). */
export type RunGroupKey = "commit" | "pull-request";

/**
 * `text` with a workflow-level `concurrency:` placed before `jobs:`, for a
 * Forgejo workflow that has none. Anything else is returned as it was.
 */
export function withRunGroup(text: string, forge: ForgeKind, key: RunGroupKey): string {
  if (forge !== "forgejo" || TOP_CONCURRENCY.test(text)) return text;
  const jobs = TOP_JOBS.exec(text);
  if (!jobs) return text;
  const name = (TOP_NAME.exec(text)?.[1] ?? "plywood").replace(/^["']|["']$/g, "");
  const group =
    key === "commit"
      ? `${name}-\${{ github.event_name }}-\${{ github.sha }}`
      : `${name}-\${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`;
  const cancel = key === "commit" ? "false" : "${{ github.event_name == 'pull_request' }}";
  const block = [
    "# Without a group Forgejo cancels the run in progress when a push starts another run of this workflow.",
    key === "commit"
      ? "# One group for each commit keeps a merge's wave jobs running to completion when another merge lands (plywood#51)."
      : "# A push to main and a comment get a group of their own, so the record job runs to completion (plywood#51).",
    "concurrency:",
    `  group: ${yamlScalar(group)}`,
    `  cancel-in-progress: ${yamlScalar(cancel)}`,
    "",
    "",
  ].join("\n");
  return text.slice(0, jobs.index) + block + text.slice(jobs.index);
}

/** `false` as it is, any expression double quoted (it holds `${{` and single quotes, which YAML would read as structure or end the scalar). */
function yamlScalar(value: string): string {
  return value === "false" ? value : JSON.stringify(value);
}
