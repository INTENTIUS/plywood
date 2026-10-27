/**
 * The repo's own CI, declared rather than hand-written.
 *
 * `just ci` renders this into .github/workflows/ci.yml, and the `package`
 * job fails when the committed file differs from what this renders. Two jobs
 * run side by side: `package` typechecks, builds and checks the plywood
 * bundle; `site` lints the prose and builds the docs site as pages.yml does,
 * without deploying it. Nothing here publishes.
 */

import { Workflow, Job, Step } from "@intentius/chant-lexicon-github";

// Actions by commit SHA, the same pins pages.yml uses.
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"; // v7.0.1
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"; // v7.0.0
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

/** The package: typecheck, the bundle and its shape, and the rendered workflow. */
export const pkg = new Job({
  name: "package",
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    ...setup("package-lock.json"),
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Typecheck", run: "npm run typecheck" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({ name: "Bundle check", run: "npm run bundle-check -w @intentius/plywood" }),
    new Step({
      name: "Workflow matches ci/ci.ts",
      run: "npx chant build ci -o .github/workflows/ci.yml --format yaml\ngit diff --exit-code -- .github/workflows/ci.yml",
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
