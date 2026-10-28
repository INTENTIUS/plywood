---
title: 'Versions and pins'
description: 'The pins for the Pulumi CLI and plunge, and the CI image digests.'
---

| Pin | Where | Example |
|---|---|---|
| Pulumi CLI | `pulumi:` in `plywood.yml`, one release or a map of stack glob to release; the image's release when absent | `3.272.0` |
| plunge | `plunge:` in `plywood.yml`, the same forms; each install is checked against the release checksums | `0.1.0` |
| Provider plugins | your program's lock file, as Pulumi reads it | `@pulumi/aws` in `package-lock.json` |
| CI image | plywood's image for each stack's engine, by digest; `image:` in `plywood.yml` names your own in its place | `ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0@sha256:...`, `ghcr.io/intentius/plywood-plunge:0.1.0-plunge0.1.0@sha256:...` |
| chant | `@intentius/chant` and its lexicons in plywood's own `package.json`, exact | `0.124.55` |
| chant the stages read | the chant release whose CI stages plywood's preview, waves, drift and approval jobs run on | `0.124.55` |

An image tag names plywood's version and the engine release the image carries. A job whose stack pins another release installs it at the start of the job.
