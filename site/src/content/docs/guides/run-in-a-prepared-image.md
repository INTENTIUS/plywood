---
title: 'Run in a prepared image'
description: 'Use an image with your plugins and language runtime installed, so each job skips the install.'
---

Each job runs in plywood's image for its engine, `plywood-pulumi` or `plywood-plunge`, with the plywood CLI installed. A program with many provider plugins, or one in a language other than Node.js, starts faster from an image of your own built from it:

```dockerfile
FROM ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0
RUN pulumi plugin install resource aws 7.4.0
RUN chmod -R a+rX /opt/plywood/pulumi-home
```

The plugins land in the image's Pulumi home, `/opt/plywood/pulumi-home`, so a job downloads none. Build and push the image in your own CI, then point the jobs at it:

```yaml
image:
  name: ghcr.io/acme/pulumi-ci@sha256:3f1c...
  plugins: [aws@7.4.0]
```

`image` also takes the reference alone. Pin the image by digest, since `plywood config check` warns about a tag. [Versions and pins](/plywood/reference/versions-and-pins/).
