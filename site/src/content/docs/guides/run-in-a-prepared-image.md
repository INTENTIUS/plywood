---
title: 'Run in a prepared image'
description: 'Use an image with your plugins and language runtime installed, so each job skips the install.'
---

Each job runs in plywood's image for its engine, `plywood-pulumi` or `plywood-plunge`, with the plywood CLI installed. A program with many provider plugins, or one in a language other than Node.js, starts faster from an image of your own built from it. plywood publishes these images in a Debian set and a Chainguard set, and you build FROM the one you want.

On the Debian set, the default:

```dockerfile
FROM ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0
USER root
RUN pulumi plugin install resource aws 7.4.0
RUN chmod -R a+rX /opt/plywood/pulumi-home
USER ${CHANT_IMAGE_USER:-root}
```

On the Chainguard set, whose tag ends in `-chainguard`:

```dockerfile
FROM ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0-chainguard
USER root
RUN pulumi plugin install resource aws 7.4.0
RUN chmod -R a+rX /opt/plywood/pulumi-home
USER ${CHANT_IMAGE_USER:-root}
```

The Chainguard images end as user 65532. That user cannot write the Pulumi home or install packages. The steps therefore run as root, and the last line sets the user back. The image's environment names that user in `CHANT_IMAGE_USER`, so the same last line works on both sets: it is 65532 on Chainguard and root on Debian, where the variable is not set. Skip the `USER` lines on Debian if you like, and keep them when the same Dockerfile may be built on either set. The Chainguard images run Node 26 where the Debian images run Node 22, and carry `apk` where the Debian ones carry `apt-get`; a step that installs an operating system package uses the set's own tool.

The plugins land in the image's Pulumi home, `/opt/plywood/pulumi-home`, so a job downloads none. Build and push the image in your own CI. Then point the jobs at it, naming the set it was built FROM:

```yaml
image:
  name: ghcr.io/acme/pulumi-ci@sha256:3f1c...
  plugins: [aws@7.4.0]
image_base: chainguard
```

`image_base` is `debian` when absent. With `image` it does not choose plywood's image; it picks the lines a job runs to install an engine release the image does not carry. On Chainguard those lines download with Node, since the image has no curl. They then link the engine into `/opt/plywood/bin`. That directory is first on the image's PATH and the image's user can write it. Leave it out when the image is built on the Debian set.

`image` also takes the reference alone. Pin the image by digest, since `plywood config check` warns about a tag. [Versions and pins](/plywood/reference/versions-and-pins/).
