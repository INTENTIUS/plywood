---
title: 'Versions and pins'
description: 'The pins for the Pulumi CLI and plunge, and the CI image digests.'
needs: [plywood#1]
draft: true
---

| Pin | Where | Example |
|---|---|---|
| Pulumi CLI | `pulumi:` in `plywood.yml` | `3.272.0` |
| plunge | `plunge:` in `plywood.yml`, checked against the release checksums | `0.1.0` |
| Provider plugins | your program's lock file, as Pulumi reads it | `@pulumi/aws` in `package-lock.json` |
| CI image | `image:` by digest | `ghcr.io/intentius/plywood-pulumi@sha256:...` |
| chant | `@intentius/chant` in plywood's own `package.json`, exact | `0.124.54` |
