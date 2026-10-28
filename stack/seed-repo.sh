#!/usr/bin/env bash
#
# Build the tutorial's example repository in <dir>: the plunge corpus's aws-ts
# program at PLUNGE_REF (stack/lib.sh), its Pulumi.yaml as project `shop`, and
# a stack file for each of dev, staging, prod-us and prod-eu with floci as a
# job on the bench's network sees it. This is the repo setup both benches
# share: stack/seed.sh runs it for plywood's own bench, and e2e/seed.ts runs
# it as the scenario seed on chant's e2e harness (plywood#25).
#
#   stack/seed-repo.sh <dir>     an existing <dir> with a .git is left alone
#
# The two config knobs the scenarios change sit far apart in each stack file,
# corpus:eventsRetentionSeconds after aws:region and corpus:workerCount last,
# so two pull requests that change one each merge without a conflict.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SHOP="${1:?usage: stack/seed-repo.sh <dir>}"
[ -d "$SHOP/.git" ] && { log "$SHOP is a repository already; keeping it"; exit 0; }
command -v git >/dev/null 2>&1 || die "git is not installed"

# The program files at PLUNGE_REF, from a local plunge checkout when it has
# the commit, else from a clone in the state dir.
src=""
plunge_dir="${PLYWOOD_PLUNGE_DIR:-$(cd "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)/../.." && pwd)/plunge}"
if git -C "$plunge_dir" cat-file -e "$PLUNGE_REF^{commit}" 2>/dev/null; then
  src="$plunge_dir"
else
  src="$STATE/plunge-src"
  if ! git -C "$src" cat-file -e "$PLUNGE_REF^{commit}" 2>/dev/null; then
    log "cloning $PLUNGE_URL for the aws-ts program…"
    mkdir -p "$STATE"
    [ -d "$src/.git" ] || git clone -q --filter=blob:none --no-checkout "$PLUNGE_URL" "$src" >&2
    git -C "$src" fetch -q origin "$PLUNGE_REF" >&2 || die "could not fetch plunge $PLUNGE_REF"
  fi
fi
log "taking $CORPUS_PATH from plunge ${PLUNGE_REF:0:10} ($src)…"
mkdir -p "$SHOP"
git -C "$src" archive "$PLUNGE_REF" \
    "$CORPUS_PATH/index.ts" "$CORPUS_PATH/package.json" "$CORPUS_PATH/package-lock.json" "$CORPUS_PATH/tsconfig.json" \
  | tar -x -C "$SHOP" --strip-components=3

cat > "$SHOP/Pulumi.yaml" <<EOT
name: shop
description: The plywood tutorial's example, the aws-ts program of plunge's corpus (INTENTIUS/plunge $CORPUS_PATH at ${PLUNGE_REF:0:10})
runtime:
  name: nodejs
  options:
    typescript: true
    packagemanager: npm
EOT
printf 'node_modules/\nbin/\n' > "$SHOP/.gitignore"

# Each stack's AWS goes to floci as a job on the bench's network sees it,
# with the test key pair and the skip flags that keep the provider off STS
# and the metadata API, as the corpus's own floci stack does.
for s in "${STACKS[@]}"; do
  cat > "$SHOP/Pulumi.$s.yaml" <<EOT
config:
  aws:region: $(stack_region "$s")
  corpus:eventsRetentionSeconds: "3600"
  aws:accessKey: test
  aws:secretKey: test
  aws:skipCredentialsValidation: true
  aws:skipRequestingAccountId: true
  aws:skipRegionValidation: true
  aws:skipMetadataApiCheck: true
  aws:s3UsePathStyle: true
  aws:endpoints:
    - ec2: ${FLOCI_NET_URL}
      iam: ${FLOCI_NET_URL}
      s3: ${FLOCI_NET_URL}
      sns: ${FLOCI_NET_URL}
      sqs: ${FLOCI_NET_URL}
      ssm: ${FLOCI_NET_URL}
      sts: ${FLOCI_NET_URL}
  corpus:flociEndpoint: ${FLOCI_NET_URL}
  corpus:prefix: plw-$s
  corpus:workerCount: "3"
EOT
done
