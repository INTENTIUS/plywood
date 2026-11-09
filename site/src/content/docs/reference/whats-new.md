---
title: 'Changes'
description: 'Changes in each plywood release.'
---

Each release lists its changes here, newest first.

## In 0.3.6

The jobs plywood writes run chant's stages from the release plywood pins, which is now 0.124.81 for chant and each of its lexicons.

Comment commands work on GitLab. `plywood ci` writes a `note-commands` job into `.gitlab-ci.yml`, and a pipeline schedule of the default branch with `CHANT_NOTE_COMMANDS=1` runs it. The job reads the merge request notes and starts the job each `/plywood` comment asks for. It needs a `CHANT_GITLAB_TOKEN` CI/CD variable; [Add plywood to a repo](/plywood/guides/add-to-a-repo/#comment-commands-on-gitlab) has the schedule and the token. An existing repository picks this up the next time you run `plywood ci`.

`plywood control init` writes the control repo's workflow with the forge lexicon plywood itself carries, so the control repo no longer needs its own install of `@intentius/chant-lexicon-github`, `-gitlab` or `-forgejo`.

## In 0.3.5

The two labels before this one were cut but never published, because the release workflow stopped before npm each time.

`plywood init` writes `approvals.preview` into the waves spec again now that the plan digest no longer refuses disjoint merges or autonamed creates. A repository that wants the 0.3.2 behavior sets `preview: false` in `plywood.yml` before it runs `plywood init`.

With chant 0.124.79 as its pin, plywood leaves several pieces of its workflows to chant that it used to write itself. When `plywood init` or `plywood ci` next writes a workflow, it differs from the old file in three places only:

- The comment line above the jobs you added by hand uses chant's wording.
- A Forgejo workflow's concurrency block has no comment lines.
- With a control repo in `plywood.yml`, chant writes the note job's read of it.

`plywood ci` keeps the `image:` and the engine install lines from `plywood.yml`, so it writes the same jobs as `plywood init` for that file. Before, each job that `plywood ci` wrote ran in `node:22` without plywood.

`plywood approve up --plan <digest>` finds the pull request from the digest whenever you leave out `--pr`, and `apply.requires` always reaches the update before merge.

The agent guard is chant's now, shared with terragucci. It also refuses the plywood verbs that change a stack or approve a change, `plywood up` and `plywood approve` among them, in an agent session inside the repository. A command inside `sh -c` or `eval` no longer slips past it. The wrappers in `.plywood/agent-bin` refuse with or without `PLYWOOD_AGENT_GUARD`, and they need Node on `PATH`. Run `plywood guard install` again to write the new hook and wrappers; it replaces the old hook line in `.claude/settings.json`.

Both images and the package now come from a single release run, which also writes the GitHub release.

The install line for a stack pinned to a Pulumi or plunge release other than the image's is chant's now, as the images' download and checksum check are. When a checksums file lists a different sum, the error ends in `chant records <sum>` where it used to end in `plywood pins <sum>`.

The release cut now builds both images from their Dockerfiles itself and writes the digest table the package pins. `scripts/release-image.sh` and `just release-image` are gone; `just images` still builds an image locally.

## In 0.3.2

plywood now pins chant 0.124.67, which fixes the refusal 0.3.1 worked around for disjoint merges: with `approvals.preview` on, a wave compares the plans it makes against the recorded ones without plunge's refresh steps, which had made unchanged plans look moved. chant also refuses a change that Rego or CrossGuard denies as policy-denied before it can merge.

With Rego rules in `plywood.yml`, `plywood init` adds `holds.policy` to the waves spec. Each wave then holds any run the rules deny. Run `plywood init` again to pick this up.

`plywood drift` reads each stack on the backend `plywood.yml` sets for it, not the job's. A stack with resources chant could not read now fails with the first one and its reason, where it used to report that the stack matches.

When a denial on a pull request prints its own subject, such as `pr-7-shop`, pass that subject to `plywood override` in place of the stack.

The package names `plywood-pulumi:0.3.2-pulumi3.272.0` and `plywood-plunge:0.3.2-plunge0.2.0` on `ghcr.io/intentius` by digest.

## In 0.3.1

`plywood init` no longer sets `approvals.preview` in the waves spec, so a merged wave applies as it did before 0.3.0, and the wave jobs carry no forge token. Two bugs found on the 0.3.0 scenario runs make the setting unsafe as a default. With it on, the second of two merges that change different resources of one stack is refused with exit 4, and so is any pull request that creates an autonamed resource. chant is fixing both, and the default goes back to on afterward.

Setting `preview: true` in `plywood.yml` and running `plywood init` again turns the behavior back on for a repository that wants it. A repository written by 0.3.0 keeps `approvals.preview` in `.chant/op-waves/pulumi-up.spec.json` when `plywood init` does not write the file again; delete the line to turn it off. When a merged wave exits 4, the message still prints the `plywood approve` line for a person to run.

This release's images are `ghcr.io/intentius/plywood-pulumi:0.3.1-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.3.1-plunge0.2.0`, named in the package by digest.

## In 0.3.0

This release moves to chant 0.124.59, and a merged wave now applies the plans its pull request previewed. `plywood init` sets `approvals.preview` in the waves spec, and the pull request workflow keeps recording each wave's plans with `plywood run wave --record-plans`. The wave job compares its fresh digest with the recorded one before it applies anything. A different digest exits 4 and applies nothing, and so does a merge with no pull request or a wave whose plans were never recorded. `plywood run wave` then prints the next step, including the `plywood approve` line chant gives for the plans it just made.

The wave jobs read the pull request through the job's token on GitHub and Forgejo. On GitLab they read a `CHANT_FORGE_TOKEN` CI/CD variable with `read_api`, which `plywood init` lists under the steps left for you. A repository written by an earlier version picks this up when you run `plywood init` again. You can also add `"approvals": { "preview": true }` to `.chant/op-waves/pulumi-up.spec.json` and `GITHUB_TOKEN: ${{ github.token }}` to each wave's `variables`, then run `plywood ci`.

`plywood drift` passes the stack to chant, so a project with several stacks reads each stack's own stored export.

Both images now carry plunge 0.2.0, checked against its checksums file, and a `plunge:` pin in `plywood.yml` takes the same version. The images the package pins by digest are `ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.3.0-plunge0.2.0`.

## In 0.2.0

This release carries the self-service work: the bench gains a command resource and gated day-2 actions, and both images now install version 1.0.1 of the command provider. It moves to chant 0.124.58, and the images it pins by digest are `ghcr.io/intentius/plywood-pulumi:0.2.0-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.2.0-plunge0.1.0`, rebuilt for this release.

## In 0.1.0

The first release of `@intentius/plywood` on npm. It pins chant 0.124.57, and its CI images are `ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0` and `ghcr.io/intentius/plywood-plunge:0.1.0-plunge0.1.0`, which the package names by digest.

`npx plywood upgrade <version>` moves a repository to a release in one pull request; with no version it takes the latest on npm. It sets `@intentius/plywood` to the release and every `@intentius/chant` and `@intentius/chant-lexicon-*` dependency to the chant that release pins, in `package.json` (keeping a `^` or `~`) and in `chant.workspace.json`'s `pins`, runs `npm install`, and runs the new release's `plywood ci`. The workflow's diff shows the image and the jobs moving. It writes no commit or branch: you open the pull request with the files it lists. `--no-install` stops after the two files and prints the commands left to run, and `--dry-run` prints the moves and changes nothing.

A `plywood.yml` whose `image` names one of plywood's own images needs the new release's image named in it, or the key dropped. A `plywood.yml` with your own `image` needs that image built again `FROM` the release's image, and its new digest named.
