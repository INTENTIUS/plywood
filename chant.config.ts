import type { ChantConfig } from "@intentius/chant";

/**
 * plywood's own config. The repo declares its CI workflow (ci/) with the
 * github lexicon; `just ci` renders it.
 */
export default {
  lexicons: ["github"],

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
