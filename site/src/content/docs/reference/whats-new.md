---
title: 'Changes'
description: 'Changes in each plywood release.'
---

Each release lists its changes here, newest first.

## In 0.4.2

This release also carries the changes made for 0.4.1, which was tagged and never published, because the scan that runs before the push found critical vulnerabilities with fixed versions in the tools the images carry and in the lockfile and stopped the release before any image or package left the build.

chant moves to `0.124.115` and the pulumi lexicon to `0.124.104`. The forgejo and github lexicons stay at `0.124.103`.

Images now come in two sets under the same repositories. The Debian set is the default. The Chainguard set is built on Chainguard's public `node` and `wolfi-base` images and has `-chainguard` on the end of its tag. `image_base: chainguard` in `plywood.yml` picks it. Those images run as user 65532 on Node 26, and their apk packages are installed at the versions chant pins. Sigstore signs every image, with SLSA provenance, after a scan that runs before the push. `plywood ci` refuses `image_base: chainguard` on an earlier plywood, which has no Chainguard images to name.

Moving Pulumi, its command provider and the AWS CLI to releases built with patched dependencies clears their findings, so both sets carry Pulumi `3.277.0` in place of `3.272.0`. Its binary and language hosts are built with Go `1.27.4`. The AWS CLI moves to `2.42.1` from `2.22.0` and bundles Python `3.14.10`. The command provider plugin in both images is now `1.3.0`. Chant has no sums for these archives, so plywood records them itself. The images and the install lines check them as they check chant's. plunge moves to `0.2.2` from `0.2.0`. It is built with Go `1.27.4` and bundles the language hosts of Pulumi `3.277.0`, so the images no longer carry hosts built with the Go releases the scan flagged. A stack with no `pulumi:` pin in `plywood.yml` now runs Pulumi `3.277.0`.

## In 0.4.0

This release pins chant `0.124.112` and the forgejo and github lexicons `0.124.103`.

`plywood promote` runs chant's `components promote` through the environments of a promotion, with a stack per environment. A stage under `environments` in `plywood.yml` carries gate and hold keys. Soak, risk and canary checks sit beside them. `plywood init` writes chant's stage pipeline from them, with `/plywood reject` on the comment job. Forge environments move to `forge_environments`, and an entry under `environments` whose value is a name or `{ name, url }` is read as that earlier spelling. `plywood rollback <env> --release <name>` takes the environment as its positional, and `--env` stays as an alias. Promotion writes `release.green: "forge-checks"` for the release cut.

`agent.alert` starts an agent job from a production alert. `agent.apply-failed` does so for a failed update and `agent.schedule` on a timer. Each opens a pull request for a person to review and is off by default. `respond.wave_refused` accepts `summary`, and `agent.verify-failed` runs after a failed verify.

Previews carry a cost estimate, and a cost hold can stop a wave. `plywood.yml` accepts hooks before and after preview and update, on chant's stage hooks. `reports.bucket` names the bucket where `plywood estate` writes `chant.estate/v1`, `chant.dora/v1` and `audit.jsonl` (`chant.audit/v1`). `plywood audit record` reads that record, and `plywood view` runs a pinned behold with the pulumi lexicon.

`plywood.yml` reads the keys of chant's product vocabulary. The earlier spellings keep working as aliases and each gives a warning. A rule that sets both `quorum` and `count` is an error.

## In 0.3.13

The chant pin moves to `0.124.106`. The lexicons now each pin their own release, since they version apart from chant: forgejo, github and gitlab at `0.124.101`, pulumi at `0.124.102`. `plywood init` pins the pulumi lexicon in `chant.workspace.json` at that release, where it used to write chant's version. In the workflows `plywood ci` writes, a multi-line `run:` block is now `run: |-`, so the first `plywood ci` after the upgrade rewrites those lines.

`plywood upgrade` moves each `@intentius/chant-lexicon-*` pin to the version the release depends on for it. It used to write the release's chant version into every lexicon pin, which named versions npm does not have. A lexicon the release does not depend on stays where it is, and the summary says so.

Release tags are `v<version>` from this release on. Releases through 0.3.12 were tagged `release/<version>`.

## In 0.3.12

The chant pin moves to `0.124.91`, for the lexicons too, so the generated workflows run their stages on that version.

With `agent.comment` set, the agent workflow now gets only the two commands its pipeline answers. Chant used to refuse the others there. `plywood ci` also writes `ops/plywood-agent.op.ts` next to the workflow, and the two files are committed together.

## In 0.3.11

This release pins chant 0.124.90 for chant and for each lexicon plywood carries, and the workflows it writes run chant's stages from that release.

On chant 0.124.89, a `plywood.yml` with `evidence` has the pull request workflow sign as well as the wave jobs. Its note job signs `plan:<member>` and `policy:<member>` for the pull request's commit, where `<member>` is the workspace member at the repository's root. A new job runs the hooks through `chant ci check` and signs each one that passed. One more job reads that evidence against the rule for the default branch and sets the `chant/ref-gate` status, which `plywood init` now asks you to require in place of `plywood/preview`, and which `plywood forge check` expects the default branch to require. The rule init writes names `plan:<member>` and `policy:<member>`. Init keeps a rule that is already there, so a trust file written by 0.3.10, whose rule names plain `plan` and `policy`, needs those two entries renamed by hand.

## In 0.3.10

This release ships the code of the cut before it, whose package never reached npm because GitHub refused the push of its release record.

A new `plywood.yml` key, `evidence`, has the wave jobs sign their checks: `identity: oidc` signs keyless from each job's OIDC token, and `runner_key_secret` signs with a runner key kept in a secret. Each wave job that decides a wave signs `plan:<wave>`. It signs `policy:<wave>` when its policy ran and denied nothing. With the key, `plywood init` writes `.chant/trust.json` with the waves workflow's identity, a ref gate rule for the default branch naming the check hooks, `plan` and `policy`, and, with `local: true`, the check hooks that take local evidence. It also installs the ref gate's pre-push hook in the clone it runs in. [Sign the checks](/plywood/guides/sign-checks/) has the details. A `plywood.yml` without the key gives the same files as before.

## In 0.3.8

Chant and each lexicon plywood carries are at 0.124.87, and chant now keeps the drift issue `plywood drift` opens for each stack. The issue's table of resources is chant's, and resources that couldn't be read are listed under it. Each open drift issue is edited once on the first run after the upgrade, then only when the drift changes.

`plywood export` takes `--version` for a numbered update on a backend that keeps history. A `plywood move` whose stack changed after it was approved stops with the moved exit code and moves nothing. `plywood cancel` checks for a run that may hold the stack's lock before it asks and again before it acts, and exits with the held code while one may; it reads the forge from plywood.yml or the repository's origin remote, and refuses when it can read neither.

A `--forge` value plywood doesn't know is refused in chant's words.

The images install the AWS CLI under `/opt/plywood/aws-cli-2.22.0`. Each engine in them is checked against its release's checksums file and against the sha256 chant records for it.

## In 0.3.7

This release carries everything 0.3.6 would have, since 0.3.6 was cut and never published after GHCR refused some of its image uploads, which chant 0.124.84 now tries again.

The jobs plywood writes run chant's stages from the release plywood pins, which is now 0.124.84 for chant and each of its lexicons.

`plywood notify relay` refuses a click when the signers file's history at the default branch doesn't verify, such as a signer added straight to main without a signed rotation, and records nothing. A repository that added a signer that way adds it again with `chant workspace signers rotate`.

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

`npx plywood upgrade <version>` moves a repository to a release in one pull request; with no version it takes the latest on npm. It sets `@intentius/plywood` to the release and `@intentius/chant` to the chant that release pins and each `@intentius/chant-lexicon-*` dependency to the version that release depends on for it (a lexicon the release does not depend on stays, with a note), in `package.json` (keeping a `^` or `~`) and in `chant.workspace.json`'s `pins`, runs `npm install`, and runs the new release's `plywood ci`. The workflow's diff shows the image and the jobs moving. It writes no commit or branch: you open the pull request with the files it lists. `--no-install` stops after the two files and prints the commands left to run, and `--dry-run` prints the moves and changes nothing.

A `plywood.yml` whose `image` names one of plywood's own images needs the new release's image named in it, or the key dropped. A `plywood.yml` with your own `image` needs that image built again `FROM` the release's image, and its new digest named.
