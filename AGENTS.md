# For agents

Working in the INTENTIUS workspace, `../agents/shared.md` applies too. This file adds what is particular to plywood.

- Read CONTRIBUTING.md first. A feature goes in chant CI core when terragucci shares it, else in chant's pulumi lexicon. plywood holds only its words, presets, config defaults, init templates and docs. Approvals, gate decisions, overrides, applies and runs are rows on the chant workspace ledger, never plywood git writes.
- No module under `packages/plywood/src` runs pulumi, plunge or git. chant runs them in process with plywood's words (`src/words.ts`). Apart from `upgrade`, only `src/view.ts` starts a process: `npx` for the pinned behold, and the platform's browser opener.
- plywood owns no exit codes. It passes chant's through; `src/exit-codes.ts` reads chant's table.
- `@intentius/chant` and every chant lexicon are pinned to one exact version, the same in the root and package manifests; `just bundle-check` holds the pin. A chant feature newer than the pin comes with a move of the pin, not a feature-detect: plywood imports what the pinned chant has, and the build fails on a subpath it lacks. The bundle does not carry chant: an `@intentius/chant` import the installed chant serves as compiled JS stays external and runs the pinned package.
- `just chant-local <chant-dir>|--reset` builds against a local chant through `chant dev local`. Run `--reset` before committing a lock file.
- Local gate: `just check`. It runs `typecheck`, `bundle-check` (which builds), `generated-check`, `test`, `site-lint` and `site` in that order, which covers every check in ci.yml, and stops at the first failure. Each recipe also runs alone.
- `ci/ci.ts` renders ci.yml. publish.yml is chant's, written by `chant release workflow --forge github` from the `release` block in `chant.config.ts`. `just ci` renders both; `just generate` renders every generated file. `pages.yml` is hand-written. Releasing is in CONTRIBUTING.md.
- Checks run on local builds, fakes, loopback servers or the floci emulator. Pulumi backends are `file://`, `plunge+file://` or S3 on floci, never a real cloud or Pulumi Cloud.
- `e2e/` is the bench on chant's e2e harness and `stack/` the tutorial bench. Neither is part of the package, and both are person-started.
- The one site page that may carry repo notes and issue links is `site/src/content/docs/reference/development.mdx`. A guide for a feature that needs a newer chant or plunge than the pin stays a draft (`draft: true` with `needs:`).

Merging: main has a merge queue. Run the local gate, push, open the pull request with `Closes #N`, queue it with `gh pr merge <n> --auto --squash`, and stop. The queue tests it on top of main and merges it; do not watch CI or use `--admin`.
