---
title: 'Changes'
description: 'Changes in each plywood release.'
---

Each release lists its changes here, newest first.

## In 0.1.0

The first release of `@intentius/plywood` on npm. It pins chant 0.124.57, and its CI images are `ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.1.0-plunge0.1.0`, which the package names by digest.

`npx plywood upgrade <version>` moves a repository to a release in one pull request; with no version it takes the latest on npm. It sets `@intentius/plywood` to the release and every `@intentius/chant` and `@intentius/chant-lexicon-*` dependency to the chant that release pins, in `package.json` (keeping a `^` or `~`) and in `chant.workspace.json`'s `pins`, runs `npm install`, and runs the new release's `plywood ci`. The workflow's diff shows the image and the jobs moving. It writes no commit or branch: you open the pull request with the files it lists. `--no-install` stops after the two files and prints the commands left to run, and `--dry-run` prints the moves and changes nothing.

A `plywood.yml` whose `image` names one of plywood's own images needs the new release's image named in it, or the key dropped. A `plywood.yml` with your own `image` needs that image built again `FROM` the release's image, and its new digest named.
