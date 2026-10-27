---
title: 'Run in a prepared image'
description: 'Use an image with your language runtime and plugins installed, so each job skips the install.'
needs: [plywood#12]
draft: true
---

Each job starts from the `plywood-pulumi` or `plywood-plunge` image. A program in Python, Go, .NET or Java, or one with many provider plugins, starts faster from an image of your own.

```dockerfile
FROM ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0
RUN pip install -r /tmp/requirements.txt
RUN pulumi plugin install resource aws 7.4.0
```

Point the jobs at it:

```yaml
image: ghcr.io/acme/pulumi-ci@sha256:3f1c...
```

Pin the image by digest. [Versions and pins](/plywood/reference/versions-and-pins/).
