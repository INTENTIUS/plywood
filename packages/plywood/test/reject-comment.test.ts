/**
 * `/plywood reject` on a pull request (plywood#156, chant#5354): chant's
 * comment job in a workflow of its own, started by the reject comment alone.
 */
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ChantProduct, ProductPipelineOptions } from "../src/chant-product";
import { REJECT_JOB, REJECT_PREFIX, rejectCommentWorkflow } from "../src/reject-comment";
import { COMMENT_WORDS, PRODUCT_WORDS, wordsForJobs } from "../src/words";
import { CHANT_DEFAULTS } from "./chant-defaults";

function fakeChant(): { chant: ChantProduct; asked: ProductPipelineOptions[] } {
  const asked: ProductPipelineOptions[] = [];
  const chant = {
    ...CHANT_DEFAULTS,
    productPipelineJobs: (forge: string, _env: string, options: ProductPipelineOptions) => {
      asked.push(options);
      const jobName = typeof options.commentJob === "object" ? (options.commentJob.jobName ?? "comment") : "comment";
      return {
        words: options.words,
        plan: { jobName: "plan", command: "" },
        post: { command: "" },
        comments: {},
        comment: { jobName, command: `npx --no-install plywood components pr-comment --forge ${forge}`, env: { GITHUB_TOKEN: "${{ github.token }}", CHANT_COMMENT_JOBS: "{}" }, prefixes: ["/plywood"] },
      };
    },
  } as unknown as ChantProduct;
  return { chant, asked };
}

describe("the reject workflow", () => {
  it("asks chant for its comment job under the reject job's name, with words that map reject", () => {
    const { chant, asked } = fakeChant();
    rejectCommentWorkflow(chant, { forge: "github", env: "dev", words: wordsForJobs(["plan", "apply"]) });
    expect(asked[0]!.commentJob).toEqual({ jobName: REJECT_JOB });
    expect((asked[0]!.words as { commands: Record<string, string> }).commands).toMatchObject({ reject: "reject" });
  });

  it("starts on a /plywood reject comment alone, and runs chant's command in plywood's image with write access to chant/lifecycle", () => {
    const { chant } = fakeChant();
    const text = rejectCommentWorkflow(chant, { forge: "github", env: "dev", words: PRODUCT_WORDS, image: "ghcr.io/intentius/plywood-plunge:1", beforeScript: ["echo setup"] })!;
    const doc = parseYAML(text) as { on: Record<string, unknown>; jobs: Record<string, Record<string, unknown>> };
    expect(doc.on).toEqual({ issue_comment: { types: ["created"] } });
    const job = doc.jobs[REJECT_JOB]!;
    expect(job.if).toContain(`startsWith(github.event.comment.body, '${REJECT_PREFIX}')`);
    expect(job.if).toContain("author_association");
    expect(job.container).toBe("ghcr.io/intentius/plywood-plunge:1");
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    const steps = job.steps as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.run).filter(Boolean)).toEqual(["echo setup", "npx --no-install plywood components pr-comment --forge github"]);
  });

  it("takes Forgejo's pull request comment, and leaves GitLab to its note poll", () => {
    const { chant } = fakeChant();
    const text = rejectCommentWorkflow(chant, { forge: "forgejo", env: "dev", words: PRODUCT_WORDS })!;
    expect(text).toContain("github.event.is_pull");
    expect(text).toContain("pr-comment --forge forgejo");
    expect(rejectCommentWorkflow(chant, { forge: "gitlab", env: "dev", words: PRODUCT_WORDS })).toBeUndefined();
  });

  it("keeps reject out of the pull request workflow's words", () => {
    expect(PRODUCT_WORDS.commands).not.toHaveProperty("reject");
    expect(COMMENT_WORDS.commands).toMatchObject({ ...PRODUCT_WORDS.commands, reject: "reject" });
  });
});
