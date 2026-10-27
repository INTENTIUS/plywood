# plywood's recipes. For now they cover the docs site in site/, as plunge's
# justfile does for plunge's site.

default:
    @just --list

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
