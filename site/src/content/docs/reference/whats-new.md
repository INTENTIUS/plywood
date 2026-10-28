---
title: 'Changes'
description: 'Changes in each plywood release.'
---

Each release lists its changes here, newest first.

`npx plywood upgrade <version>` moves a repository to a release in one pull request; with no version it takes the latest on npm. It sets `@intentius/plywood` to the release and every `@intentius/chant` and `@intentius/chant-lexicon-*` dependency to the chant that release pins, in `package.json` (keeping a `^` or `~`) and in `chant.workspace.json`'s `pins`, runs `npm install`, and runs the new release's `plywood ci`. The workflow's diff shows the image and the jobs moving. It writes no commit or branch: you open the pull request with the files it lists. `--no-install` stops after the two files and prints the commands left to run, and `--dry-run` prints the moves and changes nothing.

A `plywood.yml` whose `image` names one of plywood's own images needs the new release's image named in it, or the key dropped. A `plywood.yml` with your own `image` needs that image built again `FROM` the release's image, and its new digest named.
