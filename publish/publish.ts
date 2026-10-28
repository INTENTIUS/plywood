/**
 * Publishes @intentius/plywood to npm with trusted publishing, and pushes the
 * plywood-pulumi and plywood-plunge images (plywood#12) to GHCR.
 *
 * `just ci` renders this into .github/workflows/publish.yml. npm's trusted
 * publisher names that file, so it keeps its name: renaming it breaks
 * publishing until the setting on npmjs.com is changed too. npm trusts this
 * workflow's OIDC token, so no NPM_TOKEN exists, and the package carries a
 * provenance statement naming the run that built it.
 *
 * It runs on a `v*` tag, which `just release <version>` pushes on a green
 * commit of main, and by hand on a ref (main by default). Three jobs:
 *
 *   test     npm ci, the typecheck, the build and bundle-check, as ci.yml runs them
 *   images   on a tag, builds both images for linux/amd64 and linux/arm64 and
 *            pushes them with provenance and an SBOM, printing each reference
 *            with its digest; a reference GHCR already has is not pushed again
 *   publish  skips a version npm already has, fails on a tag that is not v plus
 *            the package version, refuses a bundle that does not pin this
 *            version's images by digest (src/image-digests.json), and runs
 *            `npm publish --provenance --access public` from packages/plywood
 *
 * The npm package names its images by digest, and a digest exists only once
 * the image is pushed, so on the tag the publish job refuses. The release then
 * records the digests (`just record-digests <run id>`), merges that to main
 * and runs this workflow on main. AGENTS.md, Releasing, has the order.
 */

import { Workflow, Job, Step } from "@intentius/chant-lexicon-github";

// Actions by commit SHA, the same pins ci.yml and pages.yml use.
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"; // v7.0.1
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"; // v7.0.0
const NODE_VERSION = "24";
/** Trusted publishing needs npm 11.5.1 or later; this one is installed when the Node in use bundles an older npm. */
const NPM_TRUSTED_PUBLISHING_MIN = "11.5.1";
const NPM_VERSION = "11.19.0";
const PACKAGE = "@intentius/plywood";
const REF = "${{ inputs.ref || github.ref }}";

export const workflow = new Workflow({
  name: "publish",
  on: {
    push: { tags: ["v*"] },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "The branch, tag or commit to publish from",
          required: true,
          default: "main",
          type: "string",
        },
      },
    },
  },
  // id-token: write lets the publish job ask GitHub for the OIDC token npm trusts.
  permissions: { contents: "read", "id-token": "write" },
  concurrency: { group: "publish", "cancel-in-progress": false },
});

const checkout = (): InstanceType<typeof Step> => new Step({ name: "Checkout", uses: CHECKOUT, with: { ref: REF } });

/** The checks ci.yml's package job runs, on the ref being released. */
export const test = new Job({
  name: "test",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    checkout(),
    new Step({ name: "Setup Node.js", uses: SETUP_NODE, with: { "node-version": NODE_VERSION, cache: "npm" } }),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Typecheck", run: "npm run typecheck" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Bundle check", run: "npm run bundle-check -w @intentius/plywood" }),
  ],
});

/** Both images, pushed on a tag; the digests it prints are what `just record-digests` checks. */
export const images = new Job({
  name: "images",
  needs: "test",
  if: "startsWith(github.ref, 'refs/tags/v')",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 60,
  // The only job that writes packages: the images to this repository's.
  permissions: { contents: "read", packages: "write" },
  steps: [
    checkout(),
    new Step({ name: "Setup Node.js", uses: SETUP_NODE, with: { "node-version": NODE_VERSION, cache: "npm" } }),
    new Step({ name: "Install", run: "npm ci" }),
    // The images install the packed package with its runtime dependencies (.dockerignore keeps the context to the tarball).
    new Step({ name: "Build the bundle", run: "npm run build" }),
    new Step({ name: "Pack the package for the images", run: "npm pack -w @intentius/plywood --pack-destination images/pack" }),
    new Step({
      name: "Log in to GHCR",
      env: { GH_TOKEN: "${{ github.token }}" },
      run: 'echo "$GH_TOKEN" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin',
    }),
    new Step({
      name: "Push both platforms, with provenance and an SBOM",
      run: [
        "set -eu",
        // arm64 builds under emulation on the amd64 runner.
        "docker run --privileged --rm tonistiigi/binfmt:latest@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64",
        "docker buildx create --use --name plywood",
        "node packages/plywood/scripts/build-images.mjs --tags | while read -r engine ref; do",
        '  if docker buildx imagetools inspect "$ref" >/dev/null 2>&1; then',
        '    echo "$ref is already pushed; not pushing it again"',
        "  else",
        '    docker buildx build --push --platform linux/amd64,linux/arm64 --provenance=mode=max --sbom=true -f "images/plywood-$engine/Dockerfile" -t "$ref" .',
        "  fi",
        '  echo "$ref $(docker buildx imagetools inspect "$ref" --format \'{{json .Manifest.Digest}}\' | tr -d \'"\')" | tee -a "$GITHUB_STEP_SUMMARY"',
        "done",
      ].join("\n"),
    }),
  ],
});

export const publish = new Job({
  name: "publish",
  needs: ["test", "images"],
  // images is skipped off a tag; publish still runs once test passes.
  if: "always() && needs.test.result == 'success' && (needs.images.result == 'success' || needs.images.result == 'skipped')",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 20,
  steps: [
    // No npm cache: a release builds from what npm ci resolves now, not from a cache another run wrote.
    checkout(),
    new Step({ name: "Setup Node.js", uses: SETUP_NODE, with: { "node-version": NODE_VERSION, "registry-url": "https://registry.npmjs.org" } }),
    new Step({
      name: `Use npm ${NPM_TRUSTED_PUBLISHING_MIN} or later, which trusted publishing needs`,
      run: [
        "set -eu",
        'have="$(npm --version)"',
        `if [ "$(printf '%s\\n' "${NPM_TRUSTED_PUBLISHING_MIN}" "$have" | sort -V | head -n1)" != "${NPM_TRUSTED_PUBLISHING_MIN}" ]; then`,
        `  echo "npm $have is older than ${NPM_TRUSTED_PUBLISHING_MIN}; installing npm ${NPM_VERSION}"`,
        `  npm install -g npm@${NPM_VERSION}`,
        "fi",
        "npm --version",
      ].join("\n"),
    }),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build the bundle", run: "npm run build" }),
    new Step({
      name: "Skip a version npm already has",
      id: "version",
      run: [
        "set -eu",
        "version=\"$(node -p 'require(\"./packages/plywood/package.json\").version')\"",
        'echo "version=$version" >> "$GITHUB_OUTPUT"',
        // A tag names the version it releases.
        'if [ "$GITHUB_EVENT_NAME" = push ] && [ "$GITHUB_REF_NAME" != "v$version" ]; then',
        '  echo "::error::tag $GITHUB_REF_NAME does not match packages/plywood/package.json version $version"',
        "  exit 1",
        "fi",
        // npm view prints the version when npm has it, and fails with E404 when it has not; any other failure stops here.
        `if out="$(npm view "${PACKAGE}@$version" version 2>&1)"; then`,
        '  if [ -n "$out" ]; then',
        `    echo "::notice::${PACKAGE}@$version is already on npm; nothing to publish"`,
        '    echo "skip=true" >> "$GITHUB_OUTPUT"',
        "    exit 0",
        "  fi",
        'elif ! printf "%s" "$out" | grep -q E404; then',
        '  echo "$out"',
        "  exit 1",
        "fi",
        `echo "${PACKAGE}@$version is not on npm yet"`,
        'echo "skip=false" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    }),
    new Step({
      name: "Refuse a bundle whose images are not pinned by digest",
      if: "steps.version.outputs.skip != 'true'",
      run: [
        "set -eu",
        "missing=0",
        "while read -r engine ref; do",
        "  digest=\"$(node -e 'const t = require(\"./packages/plywood/src/image-digests.json\"); process.stdout.write(t[process.argv[1]] ?? \"\")' \"$ref\")\"",
        '  if ! printf "%s" "$digest" | grep -Eq "^sha256:[0-9a-f]{64}$"; then',
        '    echo "::error::$ref has no digest in packages/plywood/src/image-digests.json"',
        "    missing=1",
        '  elif ! grep -q "$digest" packages/plywood/dist/plywood.mjs; then',
        '    echo "::error::the bundle does not carry the digest of $ref"',
        "    missing=1",
        "  else",
        '    echo "$engine $ref@$digest"',
        "  fi",
        'done <<< "$(node packages/plywood/scripts/build-images.mjs --tags)"',
        'if [ "$missing" -ne 0 ]; then',
        '  echo "Record each image\'s digest (just record-digests <run id>), merge that to main, and run this workflow on main."',
        "  exit 1",
        "fi",
      ].join("\n"),
    }),
    new Step({
      name: "Publish with provenance",
      if: "steps.version.outputs.skip != 'true'",
      "working-directory": "packages/plywood",
      run: "npm publish --provenance --access public",
    }),
  ],
});
