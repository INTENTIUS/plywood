import type { ChantConfig } from "@intentius/chant";
import { imageName, imageTag, REGISTRY, type EngineName } from "./packages/plywood/src/images";

/** The images a release builds and pushes, one per engine. */
const ENGINES: readonly EngineName[] = ["pulumi", "plunge"];

/** What every image copies in: the bundle, built without the release's digests, packed into images/pack. */
const PREPARE_IMAGES = "npm run build && mkdir -p images/pack && npm pack -w @intentius/plywood --pack-destination images/pack";

/** The Changes page a GitHub release takes its notes from: its `## In <version>` section. */
const CHANGES = "site/src/content/docs/reference/whats-new.md";

/**
 * plywood's own config. The repo declares its CI workflow (ci/) with the
 * github lexicon; `just ci` renders it, and `chant release workflow` writes
 * the release workflow from `release` below.
 */
export default {
  lexicons: ["github"],

  // chant.workspace.json declares no members; it is there for ci.green (the
  // ci/green tags chant-ci-green.yml writes, which the release gate reads), so
  // chant build and lint keep building this root project alone.
  rootOnly: true,

  // The declarations chant builds from this root when no directory is named: the release cut's compile reads them.
  sourceDir: "ci",

  // The release (AGENTS.md, Releasing), as terragucci's: chant's cut builds both images as
  // OCI archives from their Dockerfiles and records their digests, the bundle pins them
  // (scripts/build-cli.mjs passes them through chant's releaseImagePins), and chant's publish
  // pushes the images, publishes the package and makes the GitHub release. The label is the
  // version: the cut and the publish stamp it into the package (release.version below), so no
  // commit bumps it, and each Dockerfile reads it from the CHANT_RELEASE_LABEL build argument.
  environments: ["release"],
  release: {
    // The committed packages/plywood/package.json keeps its version; the release build alone carries the label.
    version: { packages: ["packages/plywood"] },
    // .github/workflows/publish.yml, from `chant release workflow`: one run, started by hand with
    // the version. The gate names the newest green commit at or below the dispatched one, the cut
    // builds the images and the bundle that pins them, and the publish job checks the cut's image
    // archives against its digests and publishes. npm's trusted publisher is configured for publish.yml.
    workflow: {
      trigger: "dispatch",
      gate: "last-green",
      install: "npm ci",
      build: "npm run build",
      chant: "npx chant",
      // chant works out the rest from the targets (chant issue 4786): packages: write and the run's token for
      // the GHCR oci targets, GITHUB_TOKEN for the GitHub release target, and npm 11.5.1+ for trusted publishing.
      setup: [
        // QEMU, so an amd64 runner builds the arm64 half of each image.
        { uses: "docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0", with: { platforms: "arm64" } },
      ],
      file: ".github/workflows/publish.yml",
    },
    // Each image installs the packed package, built once before the images with no digest table.
    images: ENGINES.map((name) => ({ name, dockerfile: `images/${imageName(name)}/Dockerfile`, prepare: PREPARE_IMAGES })),
    publish: [
      ...ENGINES.map((name) => ({
        type: "oci" as const,
        image: `dist/images/${name}.tar`,
        repository: `${REGISTRY}/${imageName(name)}`,
        tags: [imageTag(name, "{label}")],
        // The image's SBOM is not the repo's lockfile, so none is attached.
        sbom: false as const,
      })),
      // The package pins the images by the digests the cut recorded; the plan refuses any other.
      { type: "npm" as const, packages: ["packages/plywood"], access: "public" as const, stage: false, sbom: false as const, pins: "dist/image-digests.json" },
      {
        type: "forge" as const,
        forge: "github" as const,
        repo: "INTENTIUS/plywood",
        assets: [],
        sbom: false as const,
        notes: {
          file: CHANGES,
          heading: "## In {version}",
          linkBase: "https://intentius.io",
          before: "`@intentius/plywood@{version}` on npm. Move a repository to it with `npx @intentius/plywood@{version} upgrade {version}`.",
          after: "The [Changes page](https://intentius.io/plywood/reference/whats-new/) lists every release.",
        },
      },
    ],
  },

  lint: {
    rules: {
      // A workflow is a nested object: a job's steps and `with` blocks are its
      // shape, not values to lift into exported consts.
      COR001: "off",
      // Workflow files export jobs for the build to collect.
      COR004: "off",
    },
  },
} satisfies ChantConfig;
