# For agents

- Read CONTRIBUTING.md first. A feature goes in chant CI core when terragucci shares it, else in chant's pulumi lexicon, and plywood holds only its words, presets, config defaults, init templates and docs. Approvals, gate decisions, overrides, applies and runs are rows on the chant workspace ledger, never plywood git writes.
- No module under `packages/plywood/src` runs pulumi, plunge or git. chant runs them in process with plywood's words (`src/words.ts`).
- plywood owns no exit codes. It passes chant's through unchanged; `src/exit-codes.ts` reads chant's table and falls back to the same numbers when the installed chant lacks it.
- `@intentius/chant` and every chant lexicon are pinned to one exact version, the same in the root and package manifests (`just bundle-check` holds the pin). A chant feature newer than the pin goes behind a feature-detect with a working fallback: a lazy `import()` with `@ts-ignore`, and the subpath added to `CHANT_NEXT` in `packages/plywood/scripts/chant-exports.mjs`. The bundle does not carry chant: an `@intentius/chant` import the installed chant serves as compiled JS stays external and runs the pinned package (chant#4591).
- `just chant-local [<chant-dir>|--reset]` builds against a local chant. Go back to the pin with `--reset` before you commit a lock file.
- Before proposing a change, run `just typecheck`, `just bundle-check` and `just test`; for site changes, `just site-lint` and `just site`.
- The CI workflow is declared in `ci/ci.ts`. Edit the TypeScript and run `just ci`; never edit `.github/workflows/ci.yml` by hand, since CI fails when it differs from the render. `pages.yml` deploys the site and stays hand-written.
- Nothing here publishes to npm. The release workflow is plywood#23's.
- Every check runs on local builds, fakes, loopback servers or the floci emulator. Pulumi backends are `file://`, `plunge+file://` or S3 on floci; never a real cloud, Pulumi Cloud or the default Pulumi backend.
- The tagline is "Pull request automation for Pulumi", word for word.
- The site is for users. Notes about this repo, issue links and build status stay out of it; contributor material goes in CONTRIBUTING.md.
