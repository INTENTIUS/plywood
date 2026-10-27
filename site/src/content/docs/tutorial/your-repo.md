---
title: 'Now your repo'
description: 'Point the same setup at your own programs, stacks and backend.'
needs: [plywood#1, chant#4541, TBD-chant-product-pipeline]
draft: true
---

1. In your repository, run `npm i -D @intentius/plywood` and `npx plywood init`.
2. Check the waves `init` wrote in `plywood.yml`. The first stack listed is the canary.
3. Add the secrets `init` printed: Pulumi access tokens, or OIDC roles for a self-managed backend.
4. Protect the default branch so the `plywood/preview` status is required.
5. Open a small pull request and read the note.

Stop the bench with `just tutorial-down`. [Add plywood to a repo](/plywood/guides/add-to-a-repo/) has the full set of options.
