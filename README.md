# plywood

Sophisticated automation for Pulumi.

Built on chant; can run plunge as its engine.

It runs Pulumi previews and updates from pull requests on GitHub, GitLab or Forgejo. A change gets one preview note for every stack it reaches, then rolls out in waves, each behind an approval of its preview digest.

The runtime underneath is [chant](https://intentius.io/chant/), which terragucci shares. With [plunge](https://intentius.io/plunge/), the Pulumi fork from the same team, the pipeline also gets updates per resource.

The docs are at https://intentius.io/plywood/. The site lives in `site/`, and `just site-serve` serves it locally, while [EVIDENCE.md](EVIDENCE.md) lists the e2e scenarios and their status.

Apache-2.0 (see LICENSE).
