/**
 * The note job's read of the control repo (plywood#28, chant#4619): chant's
 * `post.control` step goes into the generated note job just before the post,
 * once, and a file without the job or a chant without the step is left as
 * chant wrote it.
 */
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { withNoteControl } from "../src/init/note-control";

const STEP = {
  stepName: "Read the control repo acme/control's records, read-only, for the cross-stack edges",
  env: { CHANT_CONTROL_READ_TOKEN: "${{ secrets.CONTROL_READ_TOKEN || github.token }}" },
  script: 'chant_control_dir="$(mktemp -d)"\necho "CHANT_CONTROL_DIR=$chant_control_dir" >>"$GITHUB_ENV"',
};

const GITHUB = [
  "jobs:",
  "  plan:",
  "    steps:",
  "      - run: npx --no-install plywood components pr-plan",
  "  plan-note:",
  "    needs:",
  "      - plan",
  "    steps:",
  "      - name: Check out the target branch's commit",
  "        uses: actions/checkout@v4",
  "      - name: Post the plan note and plywood/preview",
  "        if: always()",
  "        run: npx --no-install plywood components pr-post",
  "  record:",
  "    steps:",
  "      - run: npx --no-install plywood components pr-record",
  "",
].join("\n");

const GITLAB = [
  "stages:",
  "  - plan",
  "  - plan-note",
  "plan-note:",
  "  stage: plan-note",
  "  script:",
  "    - npx --no-install plywood components pr-post --open --env production --output .chant/pr --forge gitlab",
  "record:",
  "  script:",
  "    - npx --no-install plywood components pr-record",
  "",
].join("\n");

type Steps = { jobs: Record<string, { steps: Array<{ name?: string; env?: Record<string, string>; run?: string }> }> };

describe("withNoteControl", () => {
  it("GitHub and Forgejo: the step goes before the post, with chant's env and script", () => {
    const out = withNoteControl(GITHUB, "github", STEP);
    const steps = (parseYAML(out) as Steps).jobs["plan-note"]!.steps;
    expect(steps.map((s) => s.name)).toEqual(["Check out the target branch's commit", STEP.stepName, "Post the plan note and plywood/preview"]);
    expect(steps[1]!.env).toEqual(STEP.env);
    expect(steps[1]!.run).toContain("CHANT_CONTROL_DIR=");
    expect((parseYAML(out) as Steps).jobs.record!.steps).toHaveLength(1);
    expect(withNoteControl(out, "github", STEP)).toBe(out);
  });

  it("GitLab: the script goes in as an item before pr-post", () => {
    const out = withNoteControl(GITLAB, "gitlab", { ...STEP, env: {} });
    const script = (parseYAML(out) as Record<string, { script: string[] }>)["plan-note"]!.script;
    expect(script).toHaveLength(2);
    expect(script[0]).toContain("CHANT_CONTROL_DIR=");
    expect(script[1]).toContain("components pr-post");
  });

  it("leaves the file alone without a step, without a note job, or when chant already wrote the read", () => {
    expect(withNoteControl(GITHUB, "github", undefined)).toBe(GITHUB);
    const noNote = "jobs:\n  plan:\n    steps:\n      - run: x\n";
    expect(withNoteControl(noNote, "github", STEP)).toBe(noNote);
    const already = withNoteControl(GITHUB, "github", STEP);
    expect(withNoteControl(already, "forgejo", { ...STEP, stepName: "another name" })).toBe(already);
  });
});
