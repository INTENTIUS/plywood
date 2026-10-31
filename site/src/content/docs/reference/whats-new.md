---
title: 'Changes'
description: 'Changes in each plywood release.'
---

Each release lists its changes here, newest first.

## In 0.3.0

This release moves to chant 0.124.59, and a merged wave now applies the plans its pull request previewed. `plywood init` sets `approvals.preview` in the waves spec, and the pull request workflow keeps recording each wave's plans with `plywood run wave --record-plans`. The wave job compares its fresh digest with the recorded one before it applies anything. A different digest exits 4 and applies nothing, and so does a merge with no pull request or a wave whose plans were never recorded. `plywood run wave` then prints the next step, including the `plywood approve` line chant gives for the plans it just made.

The wave jobs read the pull request through the job's token on GitHub and Forgejo. On GitLab they read a `CHANT_FORGE_TOKEN` CI/CD variable with `read_api`, which `plywood init` lists under the steps left for you. A repository written by an earlier release picks this up when you run `plywood init` again. You can also add `"approvals": { "preview": true }` to `.chant/op-waves/pulumi-up.spec.json` and `GITHUB_TOKEN: ${{ github.token }}` to each wave's `variables`, then run `plywood ci`.

`plywood drift` passes the stack to chant, so a project with several stacks reads each stack's own stored export.

## In 0.2.0

This release carries the self-service work: the bench gains a command resource and gated day-2 actions, and both images now install version 1.0.1 of the command provider. It moves to chant 0.124.58, and the images it pins by digest are `ghcr.io/intentius/plywood-pulumi:0.2.0-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.2.0-plunge0.1.0`, rebuilt for this release.

## In 0.1.0

The first release of `@intentius/plywood` on npm. It pins chant 0.124.57, and its CI images are `ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.1.0-plunge0.1.0`, which the package names by digest.

`npx plywood upgrade <version>` moves a repository to a release in one pull request; with no version it takes the latest on npm. It sets `@intentius/plywood` to the release and every `@intentius/chant` and `@intentius/chant-lexicon-*` dependency to the chant that release pins, in `package.json` (keeping a `^` or `~`) and in `chant.workspace.json`'s `pins`, runs `npm install`, and runs the new release's `plywood ci`. The workflow's diff shows the image and the jobs moving. It writes no commit or branch: you open the pull request with the files it lists. `--no-install` stops after the two files and prints the commands left to run, and `--dry-run` prints the moves and changes nothing.

A `plywood.yml` whose `image` names one of plywood's own images needs the new release's image named in it, or the key dropped. A `plywood.yml` with your own `image` needs that image built again `FROM` the release's image, and its new digest named.
