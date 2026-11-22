# Working on plywood

## Where a feature goes

plywood and [terragucci](https://intentius.io/terragucci/) are CI products on chant's runtime, and they share chant CI features as far as they can. Extending chant CI is the default. A feature goes in the first of these homes that fits it:

1. chant CI core, when both products share it.
2. chant's terraform or pulumi lexicon, when the capability belongs to one engine. Plan shape, stack export and the apply for Pulumi and plunge stacks belong in the pulumi lexicon, and so does drift parsing.
3. plywood, which holds its words and presets, its config defaults and init templates, and its docs.

A feature stays inside plywood only for a reason that belongs to its Pulumi audience, and never for convenience. Approvals, gate decisions, overrides and the records of applies and runs go in the chant workspace ledger, never in plywood's own writes. Before adding storage for a record, check whether the ledger already holds it.

plywood credits engine features to [plunge](https://intentius.io/plunge/). A feature that needs plunge's engine names plunge where plywood describes it.

The rule and the issues behind it are on chant's [CI products on chant](https://intentius.io/chant/concepts/ci-products/) page and in [chant#4530](https://github.com/INTENTIUS/chant/issues/4530).

## Checks

`.github/workflows/ci.yml`, rendered from `ci/ci.ts` with `just ci`, runs on every pull request and push to main. Its `package` job typechecks, builds, runs the unit tests (`npm test`), checks the bundle, and fails when a committed workflow, image Dockerfile or `plywood.schema.json` differs from its render (`just generated-check`, chant's `chant dev generated-check`). Its `site` job lints the docs' prose and builds the site. Run `npm test` before you push. A change that breaks the suite doesn't merge.

## Releasing

A release is one dispatched run of publish.yml on chant's release block (`release` in `chant.config.ts`), as terragucci's is. It pushes the images of both sets to GHCR (two engines, each on Debian and on Chainguard's images), publishes `@intentius/plywood` on npm naming them by digest, and creates the GitHub release:

1. Add a `## In <version>` section to `site/src/content/docs/reference/whats-new.md` and merge it to main. Nothing else in the pull request names the version: `packages/plywood/package.json`, `package-lock.json` and the Dockerfiles keep the committed version, and the release build alone carries the label (`release.version` in `chant.config.ts`).
2. Dispatch publish.yml with the version as its label (`gh workflow run publish.yml -f label=<version>`, the bare X.Y.Z). The `gate` job hands on the dispatched commit (main's tip) and the label. The `cut` job runs `chant release cut` there, which first checks the commit's check runs on GitHub (`release.green: "forge-checks"`): it refuses the commit when a check failed or has not finished, or when the ruleset's required `package` or `site` is missing. It stamps the label into `packages/plywood/package.json` and the lockfile as the package version, builds the package, packs it into `images/pack`, then builds each of the four images as an OCI archive from its Dockerfile (the `release.images` entries in `chant.config.ts`, from `releaseImages()` in `packages/plywood/src/images.ts`, for linux/amd64 and linux/arm64, with the label as the `CHANT_RELEASE_LABEL` build argument the Dockerfiles read the tarball name and version label from), records their digests, builds the bundle with them (`scripts/build-cli.mjs` reads `CHANT_RELEASE_DIGESTS` and writes `packages/plywood/dist/image-digests.json`), restores the stamped files, records the release on `chant/lifecycle` and pushes the tag `v<version>`. Releases through 0.3.12 were tagged `release/<version>`; `release.legacyTags` keeps chant reading them as earlier releases.
3. The `publish` job stamps the label into the package again (`chant release stamp`), checks the cut's archives against the recorded digests, builds the bundle with them again, and runs `chant release publish`, which first scans every image (and the package and the GitHub release's SBOM) and stops before anything is pushed on a finding the policy blocks, then pushes `ghcr.io/intentius/plywood-pulumi:<version>-pulumi<v>` and `plywood-plunge:<version>-plunge<v>` with `-chainguard` on the tag of each Chainguard image, signs each with Sigstore and adds SLSA provenance, then the npm package (trusted publishing; the plan refuses a digest in `dist/image-digests.json` the release did not record), then the GitHub release with its notes from the Changes page's `## In <version>` section.

A build outside a release carries no digests, so a pipeline it writes runs in chant's default image with plywood's install lines. A release's bundle carries the digests of both sets, and `image_base` in `plywood.yml` picks which set a pipeline names.

### The two image sets

`packages/plywood/src/images.ts` renders four Dockerfiles with chant's `productImageDockerfile`: `images/plywood-pulumi` and `images/plywood-plunge` on Debian, and `images/plywood-pulumi-chainguard` and `images/plywood-plunge-chainguard`, which set `base: "chainguard"`. Edit the module and run `just generate`; `just generated-check` fails on a committed file that differs. The Chainguard Dockerfiles need a chant whose `@intentius/chant/ci-image` exports `CI_IMAGE_BASE_FLOOR`. Under an older chant, `dockerfile(engine, "chainguard")` and `imageRecipe(..., "chainguard")` throw and say so, and the Debian set renders as before.

The Chainguard set is chant's public `cgr.dev/chainguard/node:latest-dev` and `wolfi-base`, pinned by digest in chant (`IMAGE_PINS`), so it needs no login. It runs Node 26, where the Debian set runs Node 22, and ends as user 65532. plywood records none of its base digests: they are chant's, so they move with the chant pin, and `just generate` writes them into the Dockerfiles.

Build the sets locally, with Docker and nothing pushed:

```
just images                # Debian, as before
just images "" "" chainguard      # the Chainguard images, tagged <version>-<engine><release>-chainguard
just images "" "" both
just images linux/arm64 "" both  # the first argument is the platform, the second a checksums URL
```

To check a Chainguard image by hand, run `docker run --rm --entrypoint id ghcr.io/intentius/plywood-pulumi:<tag>-chainguard` (65532), `plywood --version`, and `pulumi version`. The `release.images` Dockerfiles must name every `FROM` by digest, since the workspace turns on `supply-chain`: `chant workspace check` reports an unpinned one, and the release build refuses it.

`chant.workspace.json` declares `"security": ["supply-chain"]`. Under it a release scans before pushing, signs with Sigstore and records provenance, so the publish job has `id-token: write` and installs cosign, grype and syft at pinned versions. The npm target keeps `sbom: false`: the package is one bundle, an SBOM file inside it would differ between the cut's pack and the publish's, and the images install that pack. chant scans it from the lockfile.

`chant release workflow` reads the security groups from the declaration at the target branch's tip (`origin/HEAD`, then `main`) when it can, and from the working tree otherwise, so render publish.yml after the declaration is on main, or in a checkout with no `main` ref, as CI's is.

Update `EVIDENCE.md` with each release (`just e2e render` regenerates it from the scenarios and the bench's recorded rows). The docs site does not show claims or recorded runs; EVIDENCE.md is where they live.

The workflow publishes with npm trusted publishing: npm accepts the job's GitHub OIDC token (`id-token: write`), so there is no npm token, and the package carries a provenance statement for the run. It needs npm 11.5.1 or later, which the job installs when Node's bundled npm is older.

The first publish is the maintainer's, by hand, because npm configures a trusted publisher only on a package that exists. From a clean checkout of main, logged in to npm with publish rights on `@intentius`: `npm ci && npm run build && npm run bundle-check -w @intentius/plywood`, then `cd packages/plywood && npm publish --access public`. Then, on npmjs.com, in `@intentius/plywood`'s settings under Trusted Publisher, GitHub Actions: organization `INTENTIUS`, repository `plywood`, workflow filename `publish.yml`, environment empty. The fields are case-sensitive and `repository.url` in `packages/plywood/package.json` must match. npm expires a trusted publisher that has not published within 2 days, so set it up shortly before the first release through the workflow. Once that release works, set the package to require two-factor authentication and disallow tokens.

`plywood upgrade [<version>]` is the user's side of a release: it moves a repository's `@intentius/plywood` and `@intentius/chant*` pins (package.json and `chant.workspace.json`'s `pins`) to the release, the chant it pins and, for each lexicon, the version the release depends on (lexicons version apart from chant; one the release lacks stays put), runs `npm install`, and runs the new plywood's `plywood ci`, so one pull request carries the move.
