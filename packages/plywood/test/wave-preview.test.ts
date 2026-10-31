/**
 * chant 0.124.59's `approvals.preview` (plywood#52): a merged wave applies the
 * plans its pull request previewed, or exits 4. Off by default since 0.3.1
 * (plywood#55, plywood#56); `preview: true` in plywood.yml turns it on. The pull request workflow
 * records the plans (`run wave --record-plans`), and the wave job reads the
 * merged pull request from the forge, so it carries a token that can.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chantProduct, setChantProductForTests } from "../src/chant-product";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { runInit } from "../src/init";

afterEach(() => setChantProductForTests("reset"));

const PREVIEW = "preview: true\n";

const real = await chantProduct();

/** `plywood init --forge` against the installed chant in a repository of two stacks; the text of every file it wrote. */
async function generated(forge: "github" | "forgejo" | "gitlab", yml?: string): Promise<Record<string, string>> {
  setChantProductForTests("reset");
  const dir = mkdtempSync(join(tmpdir(), "plywood-preview-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: nodejs\n");
  writeFileSync(join(dir, "Pulumi.dev.yaml"), "config: {}\n");
  writeFileSync(join(dir, "Pulumi.prod.yaml"), "config: {}\n");
  writeFileSync(join(dir, "package.json"), '{"name":"shop","private":true}\n');
  if (yml !== undefined) writeFileSync(join(dir, "plywood.yml"), yml);
  const was = process.cwd();
  process.chdir(dir);
  const r = await runInit({ env: "production", bucketCheck: false, dryRun: false, yes: true, forge }, FALLBACK_EXIT, { cwd: dir, env: {}, out: () => {}, err: () => {} }).finally(() => process.chdir(was));
  expect(r.ok, JSON.stringify([r.notes, r.files])).toBe(true);
  const out: Record<string, string> = {};
  for (const sub of [".github/workflows", ".forgejo/workflows", ".chant/op-waves", "."]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/\.(ya?ml|json)$/.test(f)) out[`${sub}/${f}`.replace("./", "")] = readFileSync(join(d, f), "utf8");
  }
  return out;
}

/** The text of the `job` block of a workflow: from its key to the next job. */
function jobBlock(text: string, job: string): string {
  const m = new RegExp(`^  ${job}:\\n((?:    .*\\n|\\n)+)`, "m").exec(text);
  return m?.[1] ?? "";
}

describe.runIf(real !== undefined)("approvals.preview is off unless plywood.yml says preview: true", () => {
  it("writes no approvals.preview and no wave token on GitHub, Forgejo or GitLab", async () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const files = await generated(forge);
      expect(files[".chant/op-waves/pulumi-up.spec.json"], forge).not.toContain('"preview"');
      const waves = files[forge === "github" ? ".github/workflows/pulumi-up.yml" : forge === "forgejo" ? ".forgejo/workflows/pulumi-up.yml" : "pulumi-up.gitlab-ci.yml"]!;
      expect(waves, forge).not.toContain("GITHUB_TOKEN");
    }
  }, 120_000);
});

describe.runIf(real !== undefined)("with preview: true the waves workflows apply what the pull request previewed", () => {
  it("on GitHub: the waves file can read pull requests and each wave job has a token, and the plans workflow records plans", async () => {
    const files = await generated("github", PREVIEW);
    const waves = files[".github/workflows/pulumi-up.yml"]!;
    expect(waves).toMatch(/^permissions:\n(?:  .*\n)*  pull-requests: read\n/m);
    for (const job of ["wave-1-dev", "wave-2-prod"]) expect(jobBlock(waves, job), job).toMatch(/GITHUB_TOKEN: '\${{ github\.token }}'/);
    expect(files[".github/workflows/pulumi-up-plans.yml"]).toContain("run wave --spec .chant/op-waves/pulumi-up.spec.json --record-plans");
    expect(files[".chant/op-waves/pulumi-up.spec.json"]).toContain('"preview": true');
  }, 60_000);

  it("on Forgejo: each wave job has the job token, and the plans workflow records plans", async () => {
    const files = await generated("forgejo", PREVIEW);
    const waves = files[".forgejo/workflows/pulumi-up.yml"]!;
    for (const job of ["wave-1-dev", "wave-2-prod"]) expect(jobBlock(waves, job), job).toMatch(/GITHUB_TOKEN: '\${{ github\.token }}'/);
    expect(files[".forgejo/workflows/pulumi-up-plans.yml"]).toContain("--record-plans");
  }, 60_000);

  it("on GitLab: a record-plans job on merge requests, and a wave job that reads the project's CHANT_FORGE_TOKEN", async () => {
    const files = await generated("gitlab", PREVIEW);
    const waves = files["pulumi-up.gitlab-ci.yml"]!;
    expect(waves).toMatch(/^pulumi-up-record-plans:\n(?:  .*\n)*?    - if: '\$CI_PIPELINE_SOURCE == "merge_request_event"'/m);
    expect(waves).toContain("--record-plans");
    expect(files[".chant/op-waves/pulumi-up.spec.json"]).toContain('"preview": true');
    // The token is a CI/CD variable the project holds, not a line plywood writes into the file.
    expect(waves).not.toContain("GITHUB_TOKEN");
  }, 60_000);
});
