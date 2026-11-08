/**
 * Engine pins, verified installs and the CI images (plywood#12).
 *
 * plywood pins one stock Pulumi release and one plunge release. The two
 * images, `plywood-pulumi` and `plywood-plunge`, each carry one engine at its
 * pin plus the plywood bundle; scripts/build-images.mjs renders their
 * Dockerfiles from this module into images/<name>/Dockerfile. A job runs in
 * the image for its engine, by digest in a release's bundle (the digests
 * chant's release cut recorded, which scripts/build-cli.mjs bakes in), and
 * runs the install lines for any pin the image
 * does not carry: a `pulumi:` or `plunge:` version in plywood.yml, per stack
 * glob.
 *
 * Every install checks the release's own checksums file (plunge's
 * `plunge-v<ver>-checksums.txt`, Pulumi's `pulumi-<ver>-checksums.txt`), and
 * for the pinned releases also that the file lists the sha256 plywood
 * recorded, so a tampered checksums file fails the install as a tampered
 * archive does.
 *
 * Each engine lives in /opt/plywood/<engine>-<version>/ with its language
 * hosts beside it, the default one linked into /usr/local/bin. An install
 * line skips when that directory already holds the binary, so a job in
 * plywood's image, or in an image built FROM it, installs nothing.
 *
 * chant's pulumi lexicon renders the same verified lines
 * (`@intentius/chant-lexicon-pulumi/ci-setup`, chant#4592):
 * `pulumiInstallLine` and `plungeInstallLine` take the version, the root,
 * the recorded sums and `link`. Every line is chant's, given the root
 * /opt/plywood and plywood's sums, so plywood's images still skip the
 * download. A pin that is not linked passes `link: false`: the line then
 * checks only the versioned directory, which a step pinned with
 * `engineVersion` runs from, and leaves PATH alone (chant#4814). The images'
 * fetch stage runs chant's `ciFetchScript` with the same sums.
 *
 * plywood hands the lines to chant as `beforeScript`
 * ({@link chantPipelineOptions}). A stack pinned to a release that is not
 * linked gets `engineVersion` and `engineRoot` on its `pulumi-up` step
 * (src/config/images.ts, src/init/render.ts `stepInput`), and the step runs
 * `<root>/<engine>-<version>/<engine>`.
 */
// A named import, so the bundle carries the version and not the whole package.json.
import { version as PLYWOOD_VERSION } from "../package.json";

/** The release's image digests by reference, baked in by scripts/build-cli.mjs from CHANT_RELEASE_DIGESTS; empty outside a release build. */
declare const __PLYWOOD_IMAGE_DIGESTS__: Record<string, string> | undefined;
const digests: Record<string, string> = typeof __PLYWOOD_IMAGE_DIGESTS__ !== "undefined" ? __PLYWOOD_IMAGE_DIGESTS__ : {};
import { CI_DOCKER_ARCH, ciFetchScript, plungeInstallLine, pulumiInstallLine } from "@intentius/chant-lexicon-pulumi/ci-setup";
import type { ChantRunner } from "./chant-config";

export type EngineName = "pulumi" | "plunge";

export const REGISTRY = "ghcr.io/intentius";

/**
 * The engine releases the images carry, and the version a job installs when
 * plywood.yml pins none. Pulumi matches the plunge corpus (3.272.0), which
 * plunge 0.2.0 is built from.
 */
export const TOOL_VERSIONS: Readonly<Record<EngineName, string>> = {
  pulumi: "3.272.0",
  /** A plunge release (INTENTIUS/plunge, tag plunge-v<ver>), not the Pulumi version it is built from. */
  plunge: "0.2.0",
};

/**
 * The provider plugins both images carry in their Pulumi home. The command
 * provider is the one `plywood action` needs: a day-2 action is a
 * `command:local:Command` or `command:remote:Command` resource, and its
 * replacement runs offline in a job from these images. The engine installs
 * it from the release at build time, as a prepared image's plugins are
 * (imageRecipe); plywood records no sum for it.
 */
export const IMAGE_PLUGINS: readonly PluginPin[] = [{ kind: "resource", name: "command", version: "1.0.1" }];

/** The archive's architecture word, as both projects name their Linux builds. */
export type Arch = "x64" | "arm64";
export const ARCHES: readonly Arch[] = ["x64", "arm64"];

/**
 * The sha256 of each pinned Linux archive, copied from the release's
 * checksums file. A checksums file that lists another sum for one of these
 * fails the install.
 */
export const PINNED_SHA256: Readonly<Record<string, string>> = {
  "pulumi-v3.272.0-linux-x64.tar.gz": "58d545f2b98761051922008ebd381ecef95484d7f7a5ff7faa15d7a780ea84f6",
  "pulumi-v3.272.0-linux-arm64.tar.gz": "4f0741901b8982c4326b702dabf483c63d2cf77c88ac42dd752b72541284a534",
  "plunge-v0.2.0-linux-x64.tar.gz": "c9c73d05cca9ad214b7f44230a6162cdcb6ad64bbfc725bc94688b997b191495",
  "plunge-v0.2.0-linux-arm64.tar.gz": "c176a82f038164085aa19c8ad6530d6022e560e124050e535dbe364ae0473357",
};

/** Where plywood's images and install lines keep each release: the `engineRoot` a pinned step names. */
export const ENGINE_ROOT = "/opt/plywood";

/** Where one release of one engine lives, in the images and after an install line. */
export function engineDir(engine: EngineName, version: string): string {
  return `${ENGINE_ROOT}/${engine}-${version}`;
}

/** The engine's binary at `version`. */
export function engineBin(engine: EngineName, version: string): string {
  return `${engineDir(engine, version)}/${engine}`;
}

/** One release's download: the base URL, the archive per architecture, and its checksums file. */
export interface Release {
  base: string;
  archive(arch: Arch): string;
  checksums: string;
}

export function release(engine: EngineName, version: string): Release {
  if (engine === "pulumi") {
    return {
      base: `https://github.com/pulumi/pulumi/releases/download/v${version}`,
      archive: (arch) => `pulumi-v${version}-linux-${arch}.tar.gz`,
      checksums: `pulumi-${version}-checksums.txt`,
    };
  }
  return {
    base: `https://github.com/INTENTIUS/plunge/releases/download/plunge-v${version}`,
    archive: (arch) => `plunge-v${version}-linux-${arch}.tar.gz`,
    checksums: `plunge-v${version}-checksums.txt`,
  };
}

/** The pinned sums for `version`, by architecture, when plywood recorded them. */
export function pinnedSums(engine: EngineName, version: string): Partial<Record<Arch, string>> {
  const r = release(engine, version);
  const out: Partial<Record<Arch, string>> = {};
  for (const arch of ARCHES) {
    const sum = PINNED_SHA256[r.archive(arch)];
    if (sum) out[arch] = sum;
  }
  return out;
}

/**
 * The job line that installs `engine` at `version`, checked against the
 * release checksums. It skips when the binary is already in place, as in
 * plywood's image or one built FROM it. With `link`, the binary is also
 * linked into /usr/local/bin, as the stack's default engine.
 */
export function installLine(engine: EngineName, version: string, link = true): string {
  const sums = pinnedSums(engine, version);
  const options = { root: ENGINE_ROOT, ...(Object.keys(sums).length ? { sha256: sums } : {}), link };
  return engine === "pulumi" ? pulumiInstallLine(version, options) : plungeInstallLine(version, options);
}

/** One engine at one version a job needs, and whether it is the one on PATH. */
export interface EnginePin {
  engine: EngineName;
  version: string;
  /** Linked into /usr/local/bin: the version most stacks use. */
  linked: boolean;
}

/** The install lines for `pins`, the linked one of each engine last so it wins the link. */
export function installLines(pins: readonly EnginePin[]): string[] {
  const seen = new Set<string>();
  const ordered = [...pins.filter((p) => !p.linked), ...pins.filter((p) => p.linked)];
  const out: string[] = [];
  for (const p of ordered) {
    const k = `${p.engine}@${p.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(installLine(p.engine, p.version, p.linked));
  }
  return out;
}

export interface ImageRef {
  repository: string;
  tag: string;
  /** The registry digest, known once the image is published. */
  digest?: string;
}

/** The image name for an engine. */
export function imageName(engine: EngineName): string {
  return `plywood-${engine}`;
}

/** The tag: plywood's version and the engine release it carries. */
export function imageTag(engine: EngineName, version = PLYWOOD_VERSION): string {
  return `${version}-${engine}${TOOL_VERSIONS[engine]}`;
}

/** The image a job for `engine` runs in. */
export function imageFor(engine: EngineName, table: Record<string, string> = digests): ImageRef {
  const repository = `${REGISTRY}/${imageName(engine)}`;
  const tag = imageTag(engine);
  const digest = table[`${repository}:${tag}`];
  return { repository, tag, ...(digest ? { digest } : {}) };
}

/** How a pipeline names the image: by digest when it is known, with the tag kept beside it. */
export function imageReference(ref: ImageRef): string {
  return ref.digest ? `${ref.repository}:${ref.tag}@${ref.digest}` : `${ref.repository}:${ref.tag}`;
}

/** A full image digest, as a pipeline pins one. */
export const DIGEST = /@sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// The images' Dockerfiles, rendered by scripts/build-images.mjs.

/**
 * Base images by index digest, so a rebuild cannot change underneath a tag:
 * the same two terragucci's images use. NODE carries Node 22, which a
 * TypeScript Pulumi program's language host runs on.
 */
export const BASE_IMAGES = {
  node: "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392",
  debian: "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251",
} as const;

/**
 * The AWS CLI the images carry (plywood#22): chant uploads an `s3://`
 * `reports.url` with `aws s3 cp`, which takes its credentials, region and
 * endpoint from the job's environment. A release from 2.13 on reads
 * `AWS_ENDPOINT_URL`, so a job pointed at an emulator stays on it; Debian
 * bookworm's package (2.9) does not, which is why the images fetch AWS's own
 * build, checked against these sums, rather than apt's.
 */
export const AWS_CLI = {
  version: "2.22.0",
  sha256: {
    x86_64: "f315aa564190a12ae05a05bd8ab7b0645dd4a1ad71ce9e47dae4ff3dfeee8ceb",
    aarch64: "c932ac00901ea3c430f3829140b8dc00fa6e9b8b99d6891929a4795947de7f3e",
  },
} as const;

/** Where the images install the AWS CLI; `/usr/local/bin/aws` links into it. */
export const AWS_CLI_DIR = "/opt/plywood/aws-cli";

/** The fetch stage's line for the AWS CLI: download for the build's architecture, check the sum, install under {@link AWS_CLI_DIR}. */
export function awsCliFetchLine(): string {
  const { version, sha256 } = AWS_CLI;
  return [
    `a="$(case "$TARGETARCH" in (arm64) echo aarch64 ;; (*) echo x86_64 ;; esac)"`,
    `case "$a" in (aarch64) want=${sha256.aarch64} ;; (*) want=${sha256.x86_64} ;; esac`,
    `t="$(mktemp -d)"`,
    `curl -fsSLo "$t/awscli.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$a-${version}.zip"`,
    `echo "$want  $t/awscli.zip" | sha256sum -c - >/dev/null`,
    `unzip -q "$t/awscli.zip" -d "$t"`,
    `"$t/aws/install" -i ${AWS_CLI_DIR} -b ${AWS_CLI_DIR}/bin`,
  ].join(" && ");
}

/** Where the images keep Pulumi's home, so plugins a derived image installs serve every uid. */
export const IMAGE_PULUMI_HOME = "/opt/plywood/pulumi-home";

/** Where npm pack leaves the package tarball the images install, from the repository root. */
export const PACK_DIR = "images/pack";

/** The tarball name npm pack gives the package at this version. */
export function packName(version = PLYWOOD_VERSION): string {
  return `intentius-plywood-${version}.tgz`;
}

/** The build argument a Dockerfile reads the release's version from, never from text rendered into it. */
export const RELEASE_LABEL_ARG = "CHANT_RELEASE_LABEL";
const LABEL_REF = `\${${RELEASE_LABEL_ARG}}`;

/**
 * One image's Dockerfile. The fetch stage downloads the engine and checks
 * it; the build argument `CHECKSUMS_URL` names another checksums file, which
 * is how a tampered one is shown to fail the build. curl never reaches the
 * final stage.
 */
export function dockerfile(engine: EngineName): string {
  const version = TOOL_VERSIONS[engine];
  const r = release(engine, version);
  const dir = engineDir(engine, version);
  const name = imageName(engine);
  const engineTitle = engine === "pulumi" ? `Pulumi ${version}` : `plunge ${version}`;
  return [
    `# Rendered from packages/plywood/src/images.ts by packages/plywood/scripts/build-images.mjs.`,
    `# Edit the module, then run npm run images -w @intentius/plywood. Build from the repository root`,
    `# after npm pack -w @intentius/plywood --pack-destination ${PACK_DIR}, with --build-arg ${RELEASE_LABEL_ARG}=<the packed version>`,
    `# (just images passes the committed one; a release passes its label); nothing pushes it.`,
    `FROM ${BASE_IMAGES.debian} AS fetch`,
    `ARG TARGETARCH`,
    `ARG CHECKSUMS_URL=${r.base}/${r.checksums}`,
    `RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*`,
    `RUN set -e; ${ciFetchScript(engine, version, { dir: `/out${dir}`, arch: CI_DOCKER_ARCH, checksumsUrl: '"$CHECKSUMS_URL"', sha256: pinnedSums(engine, version) })}`,
    // The AWS CLI chant uploads an s3:// reports.url with, checked against plywood's sums (AWS_CLI).
    `RUN set -e; ${awsCliFetchLine()}`,
    `FROM ${BASE_IMAGES.node}`,
    // A forge may run the job as a uid with no passwd entry; Go then reads $USER and $HOME.
    `ENV USER=plywood HOME=/tmp PULUMI_HOME=${IMAGE_PULUMI_HOME} PULUMI_SKIP_UPDATE_CHECK=true`,
    `RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*`,
    // A job often runs as another user than the one who owns its checkout.
    `RUN git config --system --add safe.directory '*' && mkdir -p ${IMAGE_PULUMI_HOME} && chmod 1777 ${IMAGE_PULUMI_HOME}`,
    `COPY --from=fetch /out/opt/plywood/ /opt/plywood/`,
    `RUN ln -s ${dir}/${engine} /usr/local/bin/${engine} && ${engine} version`,
    pluginInstallLine(engine, IMAGE_PLUGINS),
    `COPY --from=fetch ${AWS_CLI_DIR}/ ${AWS_CLI_DIR}/`,
    `RUN ln -s ${AWS_CLI_DIR}/v2/current/bin/aws /usr/local/bin/aws && aws --version`,
    // The bundle leaves @intentius/chant* external, so the image installs the packed package and npm
    // fetches its exact-pinned runtime dependencies. The tarball is made by npm pack (just images).
    // The release's label, which the release cut stamps as the package version (chant's release.version)
    // and passes as a build argument; a build outside a release passes the committed version (just images).
    `ARG ${RELEASE_LABEL_ARG}`,
    `COPY ${PACK_DIR}/${packName(LABEL_REF)} /tmp/${packName(LABEL_REF)}`,
    `RUN npm install -g --omit=dev --no-audit --no-fund /tmp/${packName(LABEL_REF)} && rm -f /tmp/${packName(LABEL_REF)} && npm cache clean --force && plywood --version`,
    `LABEL org.opencontainers.image.title="${name}"`,
    `LABEL org.opencontainers.image.description="${engineTitle}, the AWS CLI ${AWS_CLI.version} and the plywood CLI"`,
    `LABEL org.opencontainers.image.version="${LABEL_REF}"`,
    `LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/plywood"`,
    `LABEL org.opencontainers.image.licenses="Apache-2.0"`,
    `CMD ["bash"]`,
    "",
  ].join("\n");
}

/** Each image's Dockerfile, by its path from the repository root. */
export function dockerfiles(): Record<string, string> {
  return Object.fromEntries((["pulumi", "plunge"] as const).map((e) => [`images/${imageName(e)}/Dockerfile`, dockerfile(e)]));
}

// ---------------------------------------------------------------------------
// A user's prepared image: FROM plywood's, with plugins preinstalled.

/** One plugin `image.plugins` names: `aws@7.4.0`, or `resource:aws@7.4.0`. */
export interface PluginPin {
  kind: string;
  name: string;
  version: string;
}

export const PLUGIN_KINDS = ["resource", "converter", "language", "analyzer", "tool"] as const;
export const PLUGIN = /^(?:(resource|converter|language|analyzer|tool):)?([a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function parsePlugin(s: string): PluginPin | undefined {
  const m = PLUGIN.exec(s);
  return m ? { kind: m[1] ?? "resource", name: m[2]!, version: m[3]! } : undefined;
}

/**
 * The Dockerfile of a prepared image: FROM plywood's image for `engine`,
 * with each plugin installed into the image's Pulumi home, so the job's
 * engine finds them without a download. The user builds and pushes it in
 * their own CI and names it in `image`.
 */
export function imageRecipe(engine: EngineName, plugins: readonly PluginPin[], from: ImageRef = imageFor(engine)): string {
  return [
    `# A prepared image for plywood's jobs: ${engine} and the plugins below, so a job downloads none.`,
    `# Build and push it in your own CI, then name it by digest in plywood.yml's image.`,
    `FROM ${imageReference(from)}`,
    ...plugins.map((p) => `RUN ${engine} plugin install ${p.kind} ${p.name} ${p.version}`),
    `RUN chmod -R a+rX ${IMAGE_PULUMI_HOME}`,
    "",
  ].join("\n");
}

/** The Dockerfile line that installs `plugins` into the image's Pulumi home, readable by every uid. */
export function pluginInstallLine(engine: EngineName, plugins: readonly PluginPin[]): string {
  return `RUN ${[...plugins.map((p) => `${engine} plugin install ${p.kind} ${p.name} ${p.version}`), `chmod -R a+rX ${IMAGE_PULUMI_HOME}`].join(" && ")}`;
}

// ---------------------------------------------------------------------------
// Handing the image and the lines to chant.

/** The subset of chant's pipeline options the image and setup lines fill. */
export interface ChantEngineOptions {
  /** `ComponentPipelineOptions.image`. Absent: chant's default image. */
  image?: string;
  /** `ComponentPipelineOptions.beforeScript`: lines every job runs first, in any image. */
  beforeScript?: string[];
  /** `runners`, as plywood.yml gives it; the waves spec takes the `up` stage's (src/init/render.ts `waveRunner`). */
  runner?: ChantRunner;
}

/**
 * chant's build line for the image and the lines (`chant build --image`,
 * `--before-script`), for a pipeline generated over argv. The build takes
 * no product engine lines over argv, so they go to `--before-script` there.
 */
export function chantBuildFlags(o: ChantEngineOptions): string[] {
  const lines = o.beforeScript ?? [];
  return [...(o.image ? ["--image", o.image] : []), ...lines.flatMap((l) => ["--before-script", l])];
}

/**
 * The options chant's pipeline takes for plywood's image and lines: every
 * job runs the lines first, and each skips the engines the image already
 * carries.
 */
export function chantPipelineOptions(p: { image?: string; engineSetup?: string[]; runner?: ChantRunner }): ChantEngineOptions {
  const lines = p.engineSetup ?? [];
  return { ...(p.image ? { image: p.image } : {}), ...(p.runner !== undefined ? { runner: p.runner } : {}), ...(lines.length ? { beforeScript: [...lines] } : {}) };
}
