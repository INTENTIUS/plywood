#!/usr/bin/env bash
# release-image.sh <pulumi|plunge>: build one of plywood's images as the OCI
# archive a release records (chant.config.ts, release.images), as terragucci's
# scripts/release-image.sh does for its images.
#
# chant's cut runs this before the build that bakes the digests into the
# bundle, and the publish job checks the archive against the digest the cut
# recorded. Timestamps are rewritten from SOURCE_DATE_EPOCH (chant sets it to
# the commit's time), and buildx writes no attestations into the archive
# (chant attaches the SBOM and the provenance itself). The image installs the
# packed package built with no digest table.
#
# Both platforms go into one archive, an image index. Building arm64 on amd64
# needs QEMU's binfmt handlers: the publish workflow installs them, and
# Docker Desktop has them.
set -euo pipefail
engine="${1:?usage: release-image.sh <pulumi|plunge>}"
case "$engine" in pulumi | plunge) ;; *) echo "release-image.sh: no image named $engine" >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
: "${SOURCE_DATE_EPOCH:=$(git log -1 --format=%ct)}"
export SOURCE_DATE_EPOCH
platforms="${PLYWOOD_IMAGE_PLATFORMS:-linux/amd64,linux/arm64}"
builder="plywood-release"

# The package the image installs: built without CHANT_RELEASE_DIGESTS, so it is the same in the cut and the publish job.
env -u CHANT_RELEASE_DIGESTS npm run build >/dev/null
mkdir -p images/pack
npm pack -w @intentius/plywood --pack-destination images/pack >/dev/null

# An OCI archive with timestamps rewritten needs the docker-container driver.
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi

mkdir -p dist/images
docker buildx build --builder "$builder" --no-cache --platform "$platforms" \
  --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  --output "type=oci,dest=dist/images/$engine.tar,rewrite-timestamp=true" \
  -f "images/plywood-$engine/Dockerfile" . >&2
echo "dist/images/$engine.tar"
