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

# Build, then hold the package to its shape: one runtime dependency
# (@intentius/chant at the exact pin), a bundle that imports only Node's own
# modules, and a packed tarball under 2048 KB.
bundle-check: build
    npm run bundle-check -w @intentius/plywood

# Build against a local chant instead of the pin: `just chant-local` packs
# chant's origin/main from a worktree next to the chant checkout, `just
# chant-local <chant-dir>` packs that directory, and `just chant-local --reset`
# goes back to the pin. Each installed chant package gets a chantLocal field
# naming the chant commit.
chant-local *args:
    scripts/chant-local.sh {{args}}

# Render .github/workflows/ci.yml from ci/ci.ts. CI fails when the committed
# file differs from the render.
ci:
    npx chant build ci -o .github/workflows/ci.yml --format yaml

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
