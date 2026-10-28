---
title: 'Changes'
description: 'Changes in each plywood release.'
needs: [plywood#23]
draft: true
---

Each release lists its changes here, newest first.

`npx plywood upgrade <version>` moves a repository to a release in one pull request. It sets `@intentius/plywood` to the release and every `@intentius/chant` package to the chant that release pins, in `package.json` and in `chant.workspace.json`'s pins, runs `npm install`, and runs the new release's `plywood ci`. The workflow's diff shows the image and the jobs moving. `--dry-run` prints the moves and changes nothing.

A `plywood.yml` with its own `image` needs that image built again `FROM` the release's image before the upgrade.
