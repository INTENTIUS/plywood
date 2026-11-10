# Working on plywood

## Where a feature goes

plywood and [terragucci](https://intentius.io/terragucci/) are CI products on chant's runtime, and they share chant CI features as far as they can. Extending chant CI is the default. A feature goes in the first of these homes that fits it:

1. chant CI core, when both products share it.
2. chant's terraform or pulumi lexicon, when the capability belongs to one engine. Plan shape, stack export and the apply for Pulumi and plunge stacks belong in the pulumi lexicon, and so does drift parsing.
3. plywood, which holds its words and presets, its config defaults and init templates, and its docs.

A feature stays inside plywood only for a reason that belongs to its Pulumi audience, and never for convenience. Approvals, gate decisions, overrides and the records of applies and runs go in the chant workspace ledger, never in plywood's own writes. Before adding storage for a record, check whether the ledger already holds it.

plywood credits engine features to [plunge](https://intentius.io/plunge/). A feature that needs plunge's engine names plunge where plywood describes it.

The rule and the issues behind it are on chant's [CI products on chant](https://intentius.io/chant/concepts/ci-products/) page and in [chant#4530](https://github.com/INTENTIUS/chant/issues/4530).

## Checks

`.github/workflows/ci.yml`, rendered from `ci/ci.ts` with `just ci`, runs on every pull request and push to main. Its `package` job typechecks, builds, runs the unit tests (`npm test`), checks the bundle, and fails when a committed workflow, image Dockerfile or `plywood.schema.json` differs from its render (`just generated-check`, chant's `chant dev generated-check`). Its `site` job lints the docs' prose and builds the site. Run `npm test` before you push. A change that breaks the suite doesn't merge.
