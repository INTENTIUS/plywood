# plywood's recipes: the @intentius/plywood package in packages/plywood, its
# CI workflow, and the docs site in site/, as plunge's justfile does for
# plunge's site.

default:
    @just --list

# Install the package's dependencies from the root lock file.
install:
    npm ci

# Typecheck the package, its tests, ci/ and chant.config.ts.
typecheck:
    npm run typecheck

# Build the CLI into packages/plywood/dist/plywood.mjs.
build:
    npm run build

# Run the package's unit tests.
test:
    npm test

# Build, then hold the package to its shape: two runtime dependencies
# (@intentius/chant at the exact pin, @intentius/chant-lexicon-pulumi at the
# same version), a bundle that imports only Node's own modules and subpaths
# of those two that the installed packages serve as compiled JS, and a packed
# tarball under 2048 KB.
bundle-check: build
    npm run bundle-check -w @intentius/plywood

# Build against a local chant instead of the pin: `just chant-local` packs
# chant's origin/main from a worktree next to the chant checkout, `just
# chant-local <chant-dir>` packs that directory, and `just chant-local --reset`
# goes back to the pin. Each installed chant package gets a chantLocal field
# naming the chant commit.
chant-local *args:
    scripts/chant-local.sh {{args}}

# Render images/plywood-pulumi/Dockerfile and images/plywood-plunge/Dockerfile
# from packages/plywood/src/images.ts, which holds the engine pins and their
# checksums. bundle-check fails when a committed Dockerfile differs.
images-render:
    npm run images -w @intentius/plywood

# Build the plywood-pulumi and plywood-plunge images into the local Docker
# daemon for one platform (default: this machine's). Each checks its engine
# against the release checksums; `checksums=<url>` builds against another
# checksums file, so a tampered one can be shown to fail. Nothing is pushed.
images platform="" checksums="": build
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(node -p 'require("./packages/plywood/package.json").version')"
    for engine in pulumi plunge; do
      tool="$(node -e 'const s=require("fs").readFileSync("packages/plywood/src/images.ts","utf8");const m=new RegExp(process.argv[1]+": \"([^\"]+)\"").exec(s);console.log(m[1])' "$engine")"
      docker build {{ if platform == "" { "" } else { "--platform " + platform } }} \
        {{ if checksums == "" { "" } else { "--build-arg CHECKSUMS_URL=" + checksums } }} \
        -f "images/plywood-$engine/Dockerfile" -t "ghcr.io/intentius/plywood-$engine:$version-$engine$tool" .
    done

# Render .github/workflows/ci.yml from ci/ci.ts and publish.yml from
# publish/publish.ts, and chant-ci-green.yml from chant.workspace.json's
# ci.green with the pinned chant (its tick runs that chant through npx). CI
# fails when a committed file differs from the render.
ci:
    npx chant build ci -o .github/workflows/ci.yml --format yaml
    npx chant build publish -o .github/workflows/publish.yml --format yaml
    npx chant ci workflow --token-secret CI_GREEN_TOKEN

# The tutorial bench (stack/): a local Forgejo with a runner and the floci AWS
# emulator, with the repository tutor/shop holding the plunge corpus's aws-ts
# program and stacks dev, staging, prod-us and prod-eu. Containers, network and
# volumes are named plywood-tutorial; files go to stack/.state. Nothing reaches
# a real cloud, Pulumi Cloud or the default Pulumi backend.

# Start the bench, seed it and print its addresses.
tutorial-up:
    stack/tutorial.sh up

# Remove the bench's containers, network and volumes. Files under stack/.state stay.
tutorial-down:
    stack/tutorial.sh down

# Remove the bench, set stack/.state aside as stack/.state.<time>, and start afresh.
tutorial-reset:
    stack/tutorial.sh reset

# pulumi preview of a stack inside the bench on the file:// or floci S3 backend (`just tutorial-preview dev s3`).
tutorial-preview stack="dev" backend="file":
    stack/tutorial.sh preview {{stack}} {{backend}}

# Fail if a real-cloud or Pulumi Cloud URL appears in the bench's logs.
tutorial-scan:
    stack/tutorial.sh scan

# Release steps (AGENTS.md, Releasing). Each checks before it writes, and
# `--dry-run` on `release` runs every check and changes nothing.
#   just release-bump 0.1.0        the version in the package, the lock file and the Dockerfiles
#   just release 0.1.0 [--dry-run] [--commit <sha>] [--branch <b>] [--skip-green]
#                                  checks the version, the tag, npm and the packed tarball, then
#                                  tags the green commit v0.1.0 and pushes the tag
#   just record-digests [<run id>] this version's image digests from GHCR into image-digests.json
release-bump version:
    node scripts/release.mjs bump {{version}}

release version *flags:
    node scripts/release.mjs tag {{version}} {{flags}}

record-digests run="":
    node scripts/release.mjs digests {{ if run == "" { "" } else { "--run " + run } }}

# Install the site's dependencies from its lock file.
site-install:
    cd site && npm ci

# Build the docs site (Astro + Starlight) into site/dist/, as
# .github/workflows/pages.yml does. The build checks needs and drafts first,
# then rooms, links and contrast, so a broken link or a token below WCAG AA
# fails it. A production build leaves draft pages out.
site: site-install
    cd site && npm run build

# Serve the docs site locally with live reload at
# http://127.0.0.1:<port>/plywood/, draft pages included. `just site-serve 4322`
# picks another port. Astro 7 runs the dev server in the background;
# `just site-stop` stops it.
site-serve port="4321": site-install
    cd site && npm run dev -- --host 127.0.0.1 --port {{port}}

# Build, then serve site/dist/ exactly as it will be published, at
# http://127.0.0.1:<port>/plywood/.
site-preview port="4321": site
    cd site && npm run preview -- --host 127.0.0.1 --port {{port}}

# Stop the background dev server that site-serve started.
site-stop:
    cd site && npx astro dev stop

# The site's prose lint: the `sentences` rules plus the house rules, with no
# baseline. Any finding fails.
site-lint:
    cd site && npm run lint:prose
