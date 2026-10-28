import type { ChantConfig } from "@intentius/chant";

/**
 * plywood's own config. The repo declares its CI workflow (ci/) and its
 * release workflow (publish/) with the github lexicon; `just ci` renders them.
 */
export default {
  lexicons: ["github"],

  // chant.workspace.json declares no members; it is there for ci.green (the
  // ci/green tags chant-ci-green.yml writes, which `just release` reads), so
  // chant build and lint keep building this root project alone.
  rootOnly: true,

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
