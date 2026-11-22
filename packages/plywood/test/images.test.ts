import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { globMatches, pinFor } from "../src/config/images";
import { ciToolSha256 } from "@intentius/chant/ci-image";
import {
  AWS_CLI_VERSION,
  CHAINGUARD_BIN_DIR,
  CHAINGUARD_IMAGES_SINCE,
  chantBuildFlags,
  chantHasImageBase,
  chantPipelineOptions,
  dockerfile,
  dockerfiles,
  imageTag,
  releaseImages,
  setImageDigestsForTests,
  IMAGE_PLUGINS,
  engineBin,
  imageFor,
  imageRecipe,
  imageReference,
  installLine,
  parsePlugin,
  recordedSha256,
  TOOL_VERSIONS,
} from "../src/images";
import { publishedImage } from "./published-image";

const ROOT = join(import.meta.dirname, "../../..");
const settings = (text: string) => toChantSettings(parseConfig(text));
const problems = (text: string) => checkConfig(parseConfig(text));
const errors = (text: string) => problems(text).filter((p) => p.severity === "error");
/** The sums a pin is checked against: plywood's record for a release chant records none for, else chant's. */
const sumsOf = (tool: "pulumi" | "plunge" | "aws-cli", version: string) => recordedSha256(tool, version) ?? ciToolSha256(tool, version);

describe("engine pins", () => {
  it("pins stock Pulumi and plunge at published releases", () => {
    expect(TOOL_VERSIONS).toEqual({ pulumi: "3.277.0", plunge: "0.2.0" });
    // Both pins have recorded sums for both architectures: chant's (CI_TOOL_SHA256), or plywood's for a release chant lacks.
    for (const engine of ["pulumi", "plunge"] as const) {
      const sums = sumsOf(engine, TOOL_VERSIONS[engine]);
      for (const arch of ["amd64", "arm64"] as const) expect(sums[arch], `${engine} ${arch}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("installs Pulumi with no pin, linked onto PATH, skipping when the image has it", () => {
    const s = settings("");
    expect(s.pipeline.engineSetup).toEqual([installLine("pulumi", "3.277.0")]);
    const line = s.pipeline.engineSetup![0];
    expect(line).toContain('[ -x "/opt/plywood/pulumi-3.277.0/pulumi" ] ||');
    expect(line).toContain("pulumi-3.277.0-checksums.txt");
    expect(line).toContain(sumsOf("pulumi", "3.277.0").amd64!);
    expect(line).toContain(sumsOf("pulumi", "3.277.0").arm64!);
    expect(line).toContain("sha256sum -c");
    // The release's own image, by digest, in a release's build (CHANT_RELEASE_DIGESTS); by tag in any other.
    expect(s.pipeline.image).toBe(publishedImage("pulumi"));
    if (publishedImage("pulumi")) expect(s.pipeline.image).toContain("@sha256:");
  });

  it("installs plunge for plunge stacks, at the pinned release", () => {
    const s = settings("engine: plunge\nplunge: 0.2.0\nstacks:\n  shop/dev: {}\n");
    expect(s.pipeline.engineSetup).toEqual([installLine("plunge", "0.2.0")]);
    expect(s.members[0]).toMatchObject({ name: "shop/dev", engine: "plunge", engineVersion: "0.2.0" });
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
    expect(line).not.toContain(ciToolSha256("pulumi", "3.272.0").amd64!);
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
    expect(ref.tag).toMatch(/-pulumi3\.277\.0$/);
  });

  it("checks image.plugins and writes a recipe FROM plywood's image", () => {
    expect(errors("image: { name: x, plugins: [aws] }")[0].key).toBe("image.plugins[0]");
    expect(parsePlugin("aws@7.4.0")).toEqual({ kind: "resource", name: "aws", version: "7.4.0" });
    expect(parsePlugin("converter:terraform@1.0.0")).toEqual({ kind: "converter", name: "terraform", version: "1.0.0" });
    const recipe = imageRecipe("pulumi", [parsePlugin("aws@7.4.0")!], { repository: "ghcr.io/intentius/plywood-pulumi", tag: "t", digest });
    expect(recipe).toContain(`FROM ghcr.io/intentius/plywood-pulumi:t@${digest}`);
    expect(recipe).toContain("RUN pulumi plugin install resource aws 7.4.0");
  });

  it("hands chant the lines as beforeScript, in chant's default image or plywood.yml's", () => {
    const lines = ["x"];
    expect(chantPipelineOptions({ engineSetup: lines })).toEqual({ beforeScript: lines });
    expect(chantPipelineOptions({ image: "i", engineSetup: lines })).toEqual({ image: "i", beforeScript: lines });
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
    expect(IMAGE_PLUGINS).toEqual([{ kind: "resource", name: "command", version: "1.3.0" }]);
    for (const engine of ["pulumi", "plunge"] as const) {
      const lines = dockerfile(engine).split("\n");
      const install = lines.findIndex((l) => l === `RUN ${engine} plugin install resource command 1.3.0 && chmod -R a+rX /opt/plywood/pulumi-home`);
      expect(install, engine).toBeGreaterThan(lines.findIndex((l) => l.startsWith(`RUN ln -s /opt/plywood/${engine}-`)));
      expect(install, engine).toBeGreaterThan(lines.findIndex((l) => l.startsWith("ENV ") && l.includes("PULUMI_HOME=/opt/plywood/pulumi-home")));
    }
  });

  it("verify each archive against the release checksums and chant's recorded sum", () => {
    const text = dockerfile("plunge");
    expect(text).toContain("ARG CHECKSUMS_URL=https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.2.0/plunge-v0.2.0-checksums.txt");
    expect(text).toContain(ciToolSha256("plunge", "0.2.0").arm64!);
    expect(text).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    // Each download is checked in the same RUN line, before the node stage copies it.
    for (const line of text.split("\n").filter((l) => l.includes("curl -fsSLo"))) expect(line).toContain("sha256sum -c");
  });

  it("carry the AWS CLI for s3:// reports, a release that reads AWS_ENDPOINT_URL, checked by its recorded sum (plywood#22)", () => {
    const sums = sumsOf("aws-cli", AWS_CLI_VERSION);
    for (const engine of ["pulumi", "plunge"] as const) {
      const text = dockerfile(engine);
      expect(text).toContain(`f="awscli-exe-linux-$w-${AWS_CLI_VERSION}.zip"`);
      expect(text).toContain(sums.amd64!);
      expect(text).toContain(sums.arm64!);
      expect(text).toContain(`ln -sf /opt/plywood/aws-cli-${AWS_CLI_VERSION}/v2/current/bin/aws /usr/local/bin/aws`);
      expect(text).toContain("&& aws --version");
    }
    const [major, minor] = AWS_CLI_VERSION.split(".").map(Number);
    expect(major === 2 && minor! >= 13).toBe(true);
  });

  it("fails the fetch on a tampered checksums file", () => {
    // The fetch stage's shell, run against local files in place of the release.
    const dir = mkdtempSync(join(tmpdir(), "plywood-images-"));
    const f = "plunge-v0.2.0-linux-x64.tar.gz";
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
      expect(String((e as { stderr: Buffer }).stderr)).toContain("chant records");
    }
    expect(failed).toBe(true);
  });
});

describe("image sets (plywood#181)", () => {
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  const table = (sets: ("debian" | "chainguard")[]) =>
    Object.fromEntries(
      releaseImages()
        .filter((i) => sets.includes(i.set))
        .map((i) => [`${i.repository}:${i.tag()}`, sha(i.set === "debian" ? (i.engine === "pulumi" ? "a" : "b") : i.engine === "pulumi" ? "c" : "d")]),
    );
  afterEach(() => setImageDigestsForTests("reset"));

  it("publishes each engine's image in both sets, the Chainguard one under the same repository with -chainguard on its tag", () => {
    expect(chantHasImageBase()).toBe(true);
    expect(releaseImages().map((i) => [i.name, i.dockerfile, i.tag()])).toEqual([
      ["pulumi", "images/plywood-pulumi/Dockerfile", imageTag("pulumi")],
      ["plunge", "images/plywood-plunge/Dockerfile", imageTag("plunge")],
      ["pulumi-chainguard", "images/plywood-pulumi-chainguard/Dockerfile", `${imageTag("pulumi")}-chainguard`],
      ["plunge-chainguard", "images/plywood-plunge-chainguard/Dockerfile", `${imageTag("plunge")}-chainguard`],
    ]);
    expect(new Set(releaseImages().map((i) => i.repository)).size).toBe(2);
    expect(Object.keys(dockerfiles())).toEqual(releaseImages().map((i) => i.dockerfile));
  });

  it("builds the Chainguard set on chant's pinned Chainguard bases, from apk, ending as user 65532; the Debian set stays root", () => {
    for (const engine of ["pulumi", "plunge"] as const) {
      const cg = dockerfile(engine, "chainguard");
      expect(cg).toMatch(/^FROM cgr\.dev\/chainguard\/wolfi-base:latest@sha256:[0-9a-f]{64} AS fetch$/m);
      expect(cg).toMatch(/^FROM cgr\.dev\/chainguard\/node:latest-dev@sha256:[0-9a-f]{64}$/m);
      expect(cg).toContain("apk add --no-cache");
      expect(cg).not.toContain("apt-get");
      expect(cg).toContain("ENV CHANT_IMAGE_USER=65532");
      expect(cg).toContain(`ENV PATH=${CHAINGUARD_BIN_DIR}:$PATH`);
      expect(cg).toContain('LABEL io.intentius.chant.image.base="chainguard"');
      expect(cg.trimEnd().split("\n").at(-1)).toBe("USER 65532");
      expect(cg.split("\n").filter((l) => l.startsWith("USER "))).toEqual(["USER root", "USER 65532"]);
      // The engine and the AWS CLI are checked as they are on the Debian set.
      expect(cg).toContain(sumsOf(engine, TOOL_VERSIONS[engine]).amd64!);
      expect(cg).toContain(sumsOf("aws-cli", AWS_CLI_VERSION).arm64!);
      const deb = dockerfile(engine);
      expect(deb).toContain('LABEL io.intentius.chant.image.base="debian"');
      expect(deb).not.toMatch(/^USER /m);
      expect(deb).not.toContain("CHANT_IMAGE_USER");
    }
  });

  it("writes the recipe's root steps between USER root and the image's own user, on either set", () => {
    const plugins = [parsePlugin("aws@7.4.0")!];
    for (const set of ["debian", "chainguard"] as const) {
      const lines = imageRecipe("pulumi", plugins, undefined, set).split("\n").filter((l) => !l.startsWith("#") && l !== "");
      expect(lines[0], set).toMatch(new RegExp(`^FROM ghcr\\.io/intentius/plywood-pulumi:.*${set === "chainguard" ? "-chainguard" : ""}$`));
      expect(lines.slice(1), set).toEqual(["USER root", "RUN pulumi plugin install resource aws 7.4.0", "RUN chmod -R a+rX /opt/plywood/pulumi-home", "USER ${CHANT_IMAGE_USER:-root}"]);
    }
  });

  it("installs an engine in a Chainguard job with node and links it into the directory the image puts first on PATH", () => {
    const cg = installLine("pulumi", "3.250.0", true, "chainguard");
    expect(cg).toContain(`ln -sf "/opt/plywood/pulumi-3.250.0/pulumi" ${CHAINGUARD_BIN_DIR}/pulumi`);
    expect(cg).toContain("fetch(");
    expect(cg).not.toContain("curl");
    expect(cg).toContain("pulumi-3.250.0-checksums.txt");
    // The linked pin carries plywood's recorded sums on the Chainguard set's line too.
    expect(installLine("pulumi", TOOL_VERSIONS.pulumi, true, "chainguard")).toContain(sumsOf("pulumi", TOOL_VERSIONS.pulumi).arm64!);
    expect(installLine("plunge", "0.2.0", false, "chainguard")).not.toContain(CHAINGUARD_BIN_DIR);
    expect(installLine("pulumi", "3.250.0")).toContain("curl");
    const s = settings("image_base: chainguard\npulumi:\n  shop/legacy: 3.250.0\n  '*': 3.272.0\nstacks:\n  shop/dev: {}\n  shop/legacy: {}\n");
    expect(s.pipeline.engineSetup).toEqual([installLine("pulumi", "3.250.0", false, "chainguard"), installLine("pulumi", "3.272.0", true, "chainguard")]);
  });

  it("names the set's digest in the pipeline: Debian by default, Chainguard with image_base", () => {
    setImageDigestsForTests(table(["debian", "chainguard"]));
    const repo = "ghcr.io/intentius/plywood-pulumi";
    const named = (yml: string) => {
      const flags = chantBuildFlags(chantPipelineOptions(settings(yml).pipeline));
      return flags[flags.indexOf("--image") + 1];
    };
    expect(named("")).toBe(`${repo}:${imageTag("pulumi")}@${sha("a")}`);
    expect(named("image_base: debian\n")).toBe(`${repo}:${imageTag("pulumi")}@${sha("a")}`);
    expect(named("image_base: chainguard\n")).toBe(`${repo}:${imageTag("pulumi")}-chainguard@${sha("c")}`);
    expect(named("image_base: chainguard\nengine: plunge\nstacks:\n  shop/dev: {}\n")).toBe(`ghcr.io/intentius/plywood-plunge:${imageTag("plunge")}-chainguard@${sha("d")}`);
    expect(problems("image_base: chainguard\n")).toEqual([]);
  });

  it("refuses a Chainguard pick when the release carries no Chainguard digests, and names the release that does", () => {
    setImageDigestsForTests(table(["debian"]));
    const [e] = errors("image_base: chainguard\n");
    expect(e).toMatchObject({ key: "image_base", severity: "error" });
    expect(e!.message).toContain(CHAINGUARD_IMAGES_SINCE);
    expect(errors("image_base: debian\n")).toEqual([]);
    // Your own image names its own digest, so the release's table does not matter.
    expect(errors(`image: ghcr.io/acme/ci@${sha("e")}\nimage_base: chainguard\n`)).toEqual([]);
    // A build outside a release has no table, and names no image for either set.
    setImageDigestsForTests({});
    expect(errors("image_base: chainguard\n")).toEqual([]);
    expect(settings("image_base: chainguard\n").pipeline.image).toBeUndefined();
  });

  it("accepts debian and chainguard only", () => {
    expect(errors("image_base: alpine\n")[0]).toMatchObject({ key: "image_base" });
    expect(errors("image_base: 3\n")[0]).toMatchObject({ key: "image_base" });
  });
});
