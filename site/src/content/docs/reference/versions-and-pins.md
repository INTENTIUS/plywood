---
title: 'Versions and pins'
description: 'The pins for the Pulumi CLI and plunge, and the Debian and Chainguard CI image sets with their digests.'
---

| Pin | Where | Example |
|---|---|---|
| Pulumi CLI | `pulumi:` in `plywood.yml`, one release or a map of stack glob to release; the image's release when absent | `3.277.0` |
| plunge | `plunge:` in `plywood.yml`, the same forms; each install is checked against the release checksums | `0.2.0` |
| Provider plugins | your program's lock file, as Pulumi reads it | `@pulumi/aws` in `package-lock.json` |
| CI image | plywood's image for each stack's engine, from the set `image_base` picks (Debian by default), by digest; `image:` in `plywood.yml` names your own in its place | `ghcr.io/intentius/plywood-pulumi:0.4.2-pulumi3.277.0@sha256:...`, `ghcr.io/intentius/plywood-pulumi:0.4.2-pulumi3.277.0-chainguard@sha256:...` |
| chant | `@intentius/chant` in plywood's own `package.json`, exact | `0.124.115` |
| chant lexicons | each lexicon in plywood's own `package.json` at its own release, exact; `plywood init` pins the pulumi lexicon in `chant.workspace.json` at the same release | `0.124.104` |
| behold | `plywood view` runs this release of `@intentius/behold` with `npx`, and the pulumi lexicon beside it; `BEHOLD_PIN` in `packages/plywood/src/view.ts` | `0.34.2` |
| chant the stages read | the chant release whose CI stages plywood's preview, waves, drift and approval jobs run on | `0.124.115` |

An image tag names plywood's version and the engine release the image carries. A job whose stack pins another release installs it at the start of the job.

## The two image sets

Each release publishes both engine images in two sets under the same repositories. The Debian set is the default: Node 22 on `node:22-bookworm-slim`, with root as its user. The Chainguard set has `-chainguard` on the end of its tag and is built on Chainguard's public `node` and `wolfi-base` images, which need no login to pull. It runs Node 26, the Node Chainguard's image carries. Its user is 65532. The two sets carry the same Pulumi or plunge release, AWS CLI and plywood CLI. Both are labelled with the base they were built on, in `org.opencontainers.image.base.name`, `org.opencontainers.image.base.digest` and `io.intentius.chant.image.base`. The apk packages the Chainguard set installs are at versions chant pins, and they move when chant's pins move.

To run the jobs in the Chainguard set, put `image_base: chainguard` in `plywood.yml`; nothing else there changes.

The digests come from the release. The build pushes the four images and records their digests in a table that goes into the `plywood` bundle, so a pipeline `plywood ci` writes names the image of the picked set by digest. The table covers both sets, which is why a release that predates the Chainguard images has no entry for them: `plywood config check` and `plywood ci` refuse `image_base: chainguard` on it, and `plywood upgrade` moves a repository to a release that has them. A pick that names your own `image` needs no entry. A release scans its images before pushing them. They carry an SBOM of their layers. Sigstore signs them with SLSA provenance. `cosign verify` and `cosign verify-attestation` check an image against the release.

The Chainguard images are the free public ones. Chainguard's own registry for an organization, which carries version tags and FIPS images, is not one of plywood's keys: build your own image FROM plywood's set ([Run in a prepared image](/plywood/guides/run-in-a-prepared-image/)) or run the jobs in an image of your own with `image`.
