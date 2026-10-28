---
title: 'Now your repo'
description: 'Point the same setup at your own programs, stacks and backend.'
---

1. In your repository, run `npm i -D @intentius/plywood` and `npx plywood init`.
2. Check the waves `init` printed, one per environment with the canary first. It writes them to `.chant/op-waves/pulumi-up.spec.json`. For another order, set `waves` in `plywood.yml` before running `init` again.
3. Do the steps `init` lists under "Left for you": each job's cloud access through OIDC (`identity` in `plywood.yml`), and on Pulumi Cloud an OIDC issuer for the repository or the `PULUMI_ACCESS_TOKEN_PREVIEW` and `PULUMI_ACCESS_TOKEN_UP` secrets.
4. Make `plywood/preview` a required status on the default branch.
5. Open a small pull request and read the note.

Stop the bench with `just tutorial-down`. [Add plywood to a repo](/plywood/guides/add-to-a-repo/) has the full set of options.
