/**
 * The repo's own CI, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/ci.yml, and the `package`
 * job fails when the committed file differs from what this renders. Two jobs
 * run side by side: `package` typechecks, builds, runs the unit tests and
 * checks the plywood bundle; `site` lints the prose and builds the docs site as pages.yml does,
 * without deploying it. Nothing here publishes.
 */

import { ACTION_PINS, usesRef } from "@intentius/chant/action-pins";
import { Workflow, Job, Step } from "@intentius/chant-lexicon-github";

// Actions by commit SHA, from chant's pin table.
const CHECKOUT = usesRef(ACTION_PINS.checkout7);
const SETUP_NODE = usesRef(ACTION_PINS.setupNode7);
const NODE_VERSION = "24";

export const workflow = new Workflow({
  name: "plywood",
  on: {
    push: { branches: ["main"] },
    pull_request: {},
  },
  permissions: { contents: "read" },
  concurrency: { group: "ci-${{ github.ref }}", "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}" },
});

const setup = (lockFile: string): InstanceType<typeof Step>[] => [
  new Step({ name: "Checkout", uses: CHECKOUT }),
  new Step({
    name: "Setup Node.js",
    uses: SETUP_NODE,
    with: { "node-version": NODE_VERSION, cache: "npm", "cache-dependency-path": lockFile },
  }),
];

/** The package: typecheck, the unit tests, the bundle and its shape, and the rendered workflow. */
export const pkg = new Job({
  name: "package",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    ...setup("package-lock.json"),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Typecheck", run: "npm run typecheck" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Unit tests", run: "npm test" }),
    new Step({ name: "Bundle check", run: "npm run bundle-check -w @intentius/plywood" }),
    new Step({
      name: "Workflows match their declarations",
      run: [
        "npx chant build ci -o .github/workflows/ci.yml --format yaml",
        "npx chant build publish -o .github/workflows/publish.yml --format yaml",
        "npx chant ci workflow --token-secret CI_GREEN_TOKEN",
        "git diff --exit-code -- .github/workflows",
      ].join("\n"),
    }),
  ],
});

/** The docs site, built as pages.yml builds it, with no deploy. */
export const site = new Job({
  name: "site",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  defaults: { run: { "working-directory": "site" } },
  steps: [
    ...setup("site/package-lock.json"),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Lint prose", run: "npm run lint:prose" }),
    new Step({ name: "Build the site", run: "npm run build" }),
  ],
});
