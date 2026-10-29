import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { globMatches, pinFor } from "../src/config/images";
import {
  AWS_CLI,
  chantPipelineOptions,
  dockerfile,
  dockerfiles,
  IMAGE_PLUGINS,
  engineBin,
  imageFor,
  imageRecipe,
  imageReference,
  installLine,
  parsePlugin,
  PINNED_SHA256,
  release,
  TOOL_VERSIONS,
} from "../src/images";

const ROOT = join(import.meta.dirname, "../../..");
const settings = (text: string) => toChantSettings(parseConfig(text));
const problems = (text: string) => checkConfig(parseConfig(text));
const errors = (text: string) => problems(text).filter((p) => p.severity === "error");

describe("engine pins", () => {
  it("pins stock Pulumi at the corpus's release and plunge at a published one", () => {
    expect(TOOL_VERSIONS).toEqual({ pulumi: "3.272.0", plunge: "0.1.0" });
    for (const engine of ["pulumi", "plunge"] as const) {
      const r = release(engine, TOOL_VERSIONS[engine]);
      for (const arch of ["x64", "arm64"] as const) expect(PINNED_SHA256[r.archive(arch)], r.archive(arch)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(release("plunge", "0.1.0").checksums).toBe("plunge-v0.1.0-checksums.txt");
  });

  it("installs Pulumi with no pin, linked onto PATH, skipping when the image has it", () => {
    const s = settings("");
    expect(s.pipeline.engineSetup).toEqual([installLine("pulumi", "3.272.0")]);
    const line = s.pipeline.engineSetup![0];
    expect(line).toContain('[ -x "/opt/plywood/pulumi-3.272.0/pulumi" ] ||');
    expect(line).toContain("pulumi-3.272.0-checksums.txt");
    expect(line).toContain(PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]);
    expect(line).toContain("sha256sum -c");
    // The release's own image, by digest, once image-digests.json holds it.
    expect(s.pipeline.image).toBe(imageReference(imageFor("pulumi")));
    expect(s.pipeline.image).toContain("@sha256:");
  });

  it("installs plunge for plunge stacks, at the pinned release", () => {
    const s = settings("engine: plunge\nplunge: 0.1.0\nstacks:\n  shop/dev: {}\n");
    expect(s.pipeline.engineSetup).toEqual([installLine("plunge", "0.1.0")]);
    expect(s.members[0]).toMatchObject({ name: "shop/dev", engine: "plunge", engineVersion: "0.1.0" });
  });

  it("installs another release beside the linked one for a stack a glob pins", () => {
    const s = settings("pulumi:\n  shop/legacy: 3.250.0\n  '*': 3.272.0\nstacks:\n  shop/dev: {}\n  shop/prod: {}\n  shop/legacy: {}\n");
    expect(s.pipeline.engineSetup).toEqual([installLine("pulumi", "3.250.0", false), installLine("pulumi", "3.272.0")]);
    const legacy = s.members.find((m) => m.name === "shop/legacy")!;
    expect(legacy).toMatchObject({ engineVersion: "3.250.0", engineBin: engineBin("pulumi", "3.250.0") });
    expect(s.members.find((m) => m.name === "shop/dev")!.engineBin).toBeUndefined();
  });

  it("checks a release with no recorded sum against its checksums file alone", () => {
    const line = installLine("pulumi", "3.250.0");
    expect(line).toContain("want=");
    expect(line).not.toContain(PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]);
  });

  it("matches stack globs", () => {
    expect(globMatches("shop/prod-*", "shop/prod-eu")).toBe(true);
    expect(globMatches("shop/prod-*", "shop/dev")).toBe(false);
    expect(pinFor({ "shop/*": "1.0.0", "*": "2.0.0" }, "web/dev")).toBe("2.0.0");
    expect(pinFor("3.0.0", "web/dev")).toBe("3.0.0");
  });

  it("refuses a release that is not a version and warns on a glob that matches no stack", () => {
    expect(errors("pulumi: latest")[0].key).toBe("pulumi");
    expect(errors("plunge: { shop/dev: v1 }")[0].key).toBe("plunge.shop/dev");
    const w = problems("stacks:\n  shop/dev: {}\npulumi:\n  web/*: 3.272.0\n");
    expect(w).toEqual([expect.objectContaining({ key: "pulumi.web/*", severity: "warning" })]);
  });
});

describe("image", () => {
  const digest = "sha256:" + "a".repeat(64);

  it("runs every job in the user's image, warning when it is not pinned by digest", () => {
    expect(settings(`image: ghcr.io/acme/ci@${digest}\n`).pipeline.image).toBe(`ghcr.io/acme/ci@${digest}`);
    expect(problems(`image: ghcr.io/acme/ci@${digest}\n`)).toEqual([]);
    expect(problems("image: ghcr.io/acme/ci:latest\n")).toEqual([expect.objectContaining({ key: "image", severity: "warning" })]);
  });

  it("pins plywood's image by digest once one is recorded, and names no unpublished image", () => {
    const ref = imageFor("pulumi", {});
    expect(ref.digest).toBeUndefined();
    const table = { [`${ref.repository}:${ref.tag}`]: digest };
    expect(imageReference(imageFor("pulumi", table))).toBe(`${ref.repository}:${ref.tag}@${digest}`);
    expect(ref.repository).toBe("ghcr.io/intentius/plywood-pulumi");
    expect(ref.tag).toMatch(/-pulumi3\.272\.0$/);
  });

  it("checks image.plugins and writes a recipe FROM plywood's image", () => {
    expect(errors("image: { name: x, plugins: [aws] }")[0].key).toBe("image.plugins[0]");
    expect(parsePlugin("aws@7.4.0")).toEqual({ kind: "resource", name: "aws", version: "7.4.0" });
    expect(parsePlugin("converter:terraform@1.0.0")).toEqual({ kind: "converter", name: "terraform", version: "1.0.0" });
    const recipe = imageRecipe("pulumi", [parsePlugin("aws@7.4.0")!], { repository: "ghcr.io/intentius/plywood-pulumi", tag: "t", digest });
    expect(recipe).toContain(`FROM ghcr.io/intentius/plywood-pulumi:t@${digest}`);
    expect(recipe).toContain("RUN pulumi plugin install resource aws 7.4.0");
  });

  it("hands chant the lines as engineSetup only in chant's default image with a chant that reads it", () => {
    const lines = ["x"];
    expect(chantPipelineOptions({ engineSetup: lines }, true)).toEqual({ prLoop: { engineSetup: lines } });
    expect(chantPipelineOptions({ engineSetup: lines }, false)).toEqual({ beforeScript: lines });
    expect(chantPipelineOptions({ image: "i", engineSetup: lines }, true)).toEqual({ image: "i", beforeScript: lines });
  });
});

describe("runners", () => {
  it("passes a runner through and checks its shape", () => {
    expect(settings("runners: [self-hosted, linux]\n").pipeline.runner).toEqual(["self-hosted", "linux"]);
    expect(settings("runners: { default: ubuntu-latest, up: [self-hosted, prod] }\n").pipeline.runner).toEqual({ default: "ubuntu-latest", up: ["self-hosted", "prod"] });
    expect(errors("runners: { apply: x }")[0].key).toBe("runners.apply");
    expect(errors("runners: 'two words'")[0].key).toBe("runners");
    expect(errors("forge: { kind: gitlab }\nrunners: { group: infra }")[0].key).toBe("runners.group");
  });
});

describe("Dockerfiles", () => {
  it("match the committed images/*/Dockerfile", () => {
    for (const [path, text] of Object.entries(dockerfiles())) expect(readFileSync(join(ROOT, path), "utf8"), path).toBe(text);
  });

  it("carry the command provider at its pin in the Pulumi home, installed by the image's engine once it is on PATH", () => {
    expect(IMAGE_PLUGINS).toEqual([{ kind: "resource", name: "command", version: "1.0.1" }]);
    for (const engine of ["pulumi", "plunge"] as const) {
      const lines = dockerfile(engine).split("\n");
      const install = lines.findIndex((l) => l === `RUN ${engine} plugin install resource command 1.0.1 && chmod -R a+rX /opt/plywood/pulumi-home`);
      expect(install, engine).toBeGreaterThan(lines.findIndex((l) => l.startsWith(`RUN ln -s /opt/plywood/${engine}-`)));
      expect(install, engine).toBeGreaterThan(lines.findIndex((l) => l.startsWith("ENV ") && l.includes("PULUMI_HOME=/opt/plywood/pulumi-home")));
    }
  });

  it("verify each archive against the release checksums and plywood's pinned sum", () => {
    const text = dockerfile("plunge");
    expect(text).toContain("ARG CHECKSUMS_URL=https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.1.0/plunge-v0.1.0-checksums.txt");
    expect(text).toContain(PINNED_SHA256["plunge-v0.1.0-linux-arm64.tar.gz"]);
    expect(text).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    // Each download is checked in the same RUN line, before the node stage copies it.
    for (const line of text.split("\n").filter((l) => l.includes("curl -fsSLo"))) expect(line).toContain("sha256sum -c");
  });

  it("carry the AWS CLI for s3:// reports, a release that reads AWS_ENDPOINT_URL, checked by plywood's sum (plywood#22)", () => {
    for (const engine of ["pulumi", "plunge"] as const) {
      const text = dockerfile(engine);
      expect(text).toContain(`https://awscli.amazonaws.com/awscli-exe-linux-$a-${AWS_CLI.version}.zip`);
      expect(text).toContain(AWS_CLI.sha256.aarch64);
      expect(text).toContain(AWS_CLI.sha256.x86_64);
      expect(text).toContain("COPY --from=fetch /opt/plywood/aws-cli/ /opt/plywood/aws-cli/");
      expect(text).toContain("RUN ln -s /opt/plywood/aws-cli/v2/current/bin/aws /usr/local/bin/aws && aws --version");
    }
    const [major, minor] = AWS_CLI.version.split(".").map(Number);
    expect(major === 2 && minor! >= 13).toBe(true);
  });

  it("fails the AWS CLI fetch on an archive whose sum is not plywood's", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-images-"));
    writeFileSync(join(dir, "awscli.zip"), "not the archive");
    const run = dockerfile("plunge").split("\n").find((l) => l.startsWith("RUN set -e;") && l.includes("awscli"))!.slice(4)
      .replace(/curl -fsSLo "\$t\/awscli.zip" "[^"]+"/, `cp "${dir}/awscli.zip" "$t/awscli.zip"`);
    expect(() => execFileSync("sh", ["-c", run], { env: { ...process.env, TARGETARCH: "arm64" }, stdio: "pipe" })).toThrow();
  });

  it("fails the fetch on a tampered checksums file", () => {
    // The fetch stage's shell, run against local files in place of the release.
    const dir = mkdtempSync(join(tmpdir(), "plywood-images-"));
    const f = "plunge-v0.1.0-linux-x64.tar.gz";
    writeFileSync(join(dir, f), "not the archive");
    writeFileSync(join(dir, "sums"), `${"0".repeat(64)}  ${f}\n`);
    const run = dockerfile("plunge").split("\n").find((l) => l.startsWith("RUN set -e;"))!.slice(4)
      .replace(/curl -fsSLo "\$t\/\$f" "[^"]+"/, `cp "${dir}/$f" "$t/$f"`)
      .replace(/curl -fsSLo "\$t\/sums" "\$CHECKSUMS_URL"/, `cp "${dir}/sums" "$t/sums"`);
    let failed = false;
    try {
      execFileSync("sh", ["-c", run], { env: { ...process.env, TARGETARCH: "amd64" }, stdio: "pipe" });
    } catch (e) {
      failed = true;
      expect(String((e as { stderr: Buffer }).stderr)).toContain("plywood pins");
    }
    expect(failed).toBe(true);
  });
});
