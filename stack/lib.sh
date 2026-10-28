# shellcheck shell=bash disable=SC2034
# Shared settings for the tutorial bench, sourced by stack/tutorial.sh and
# stack/seed.sh. Every value can be overridden from the environment.
#
# The bench never reaches a real cloud, Pulumi Cloud or the default Pulumi
# backend: AWS is floci with the key pair test/test, Pulumi's backend is a
# file:// directory under the state dir or the S3 bucket on floci, and the
# variables that could point a tool elsewhere are cleared here.

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/.." && pwd)"

PROJECT="plywood-tutorial"
NETWORK="plywood-tutorial"
COMPOSE=(docker compose -f "$STACK_DIR/compose.yml" --project-name "$PROJECT")

FORGEJO_PORT="${PLYWOOD_TUTORIAL_FORGEJO_PORT:-3390}"
FLOCI_PORT="${PLYWOOD_TUTORIAL_FLOCI_PORT:-4590}"
FORGEJO_URL="http://127.0.0.1:${FORGEJO_PORT}"
FLOCI_URL="http://127.0.0.1:${FLOCI_PORT}"
# The same two servers as a job container on the network sees them.
FORGEJO_NET_URL="http://forgejo:3000"
FLOCI_NET_URL="http://floci:4566"

# Files the bench writes: the example repository, the file:// backend, logs
# and the env file. Ignored by git.
STATE="${PLYWOOD_TUTORIAL_STATE:-$STACK_DIR/.state}"

# A throwaway forge on loopback; these never leave the machine.
TUTOR_USER="tutor"
TUTOR_PW="plywood-tutorial-local"
TUTOR_EMAIL="tutor@plywood-tutorial.local"
REPO_NAME="shop"
RUNNER_NAME="plywood-tutorial-docker"
RUNNER_CAPACITY="${PLYWOOD_TUTORIAL_RUNNER_CAPACITY:-4}"

# The stacks of ruling 9 on plywood#1, each with its own corpus:prefix so
# their resources never share a physical name on the one floci, and the
# region each one runs in.
STACKS=(dev staging prod-us prod-eu)
stack_region() {
  case "$1" in
    prod-eu) echo eu-west-1 ;;
    *) echo us-east-1 ;;
  esac
}

# The aws-ts program comes from plunge's corpus at this commit: plunge's main
# after plunge#55, whose per-resource timings the claims scenarios read. Taken from PLYWOOD_PLUNGE_DIR when that
# checkout has the commit, else cloned from GitHub into the state dir.
PLUNGE_REF="${PLYWOOD_TUTORIAL_PLUNGE_REF:-812cfd894151027dbc22269a5a8b43fb53368ec2}"
PLUNGE_URL="https://github.com/INTENTIUS/plunge.git"
CORPUS_PATH="tests/plunge-corpus/aws-ts"

# Pulumi runs in this image for the seed and for `tutorial.sh preview`, on the
# bench's network, so it reads no host credentials or Pulumi login. The
# version is the one the corpus program pins (@pulumi/pulumi 3.272.0).
PULUMI_IMAGE="${PLYWOOD_TUTORIAL_PULUMI_IMAGE:-pulumi/pulumi-nodejs:3.272.0}"
# The image the runner starts jobs in, under both labels a workflow may ask
# for: plywood's pulumi image as `just images` tags it in the local Docker
# daemon (plywood#28), ghcr.io/intentius/plywood-pulumi:<plywood>-pulumi<pulumi>,
# with the plywood CLI and the pinned Pulumi in it. The tag is read from
# packages/plywood/package.json and the Pulumi pin in packages/plywood/src/images.ts,
# the two `just images` reads. The runner never pulls it (force_pull: false),
# so build it before `just tutorial-up`; PLYWOOD_TUTORIAL_JOB_IMAGE names another.
plywood_image_tag() { # engine (pulumi|plunge)
  local version tool
  version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$REPO_ROOT/packages/plywood/package.json" | head -n 1)"
  tool="$(sed -n "s/^  $1: \"\([^\"]*\)\".*/\1/p" "$REPO_ROOT/packages/plywood/src/images.ts" | head -n 1)"
  [ -n "$version" ] && [ -n "$tool" ] || return 1
  echo "ghcr.io/intentius/plywood-$1:$version-$1$tool"
}
JOB_IMAGE="${PLYWOOD_TUTORIAL_JOB_IMAGE:-$(plywood_image_tag pulumi || echo ghcr.io/intentius/plywood-pulumi)}"

# The self-managed backend: an S3 bucket on floci, path-style.
BUCKET="plywood-tutorial-state"
# plunge's record store (tutorial/plunge.mdx), set up the way plunge#34 asks.
PLUNGE_BUCKET="plywood-tutorial-plunge"
PLUNGE_STORE_NET="plunge+s3://${PLUNGE_BUCKET}?region=us-east-1&endpoint=${FLOCI_NET_URL}&s3ForcePathStyle=true"
PLUNGE_STORE_HOST="plunge+s3://${PLUNGE_BUCKET}?region=us-east-1&endpoint=${FLOCI_URL}&s3ForcePathStyle=true"
S3_BACKEND_NET="s3://${BUCKET}?region=us-east-1&endpoint=${FLOCI_NET_URL}&use_path_style=true"
S3_BACKEND_HOST="s3://${BUCKET}?region=us-east-1&endpoint=${FLOCI_URL}&use_path_style=true"
FILE_BACKEND_DIR="$STATE/backend"

# A static passphrase for the stacks' secrets; the bench's secrets are its own.
PASSPHRASE="plywood-tutorial"

# Nothing the bench starts may pick up a real account or the default backend.
unset GOOGLE_APPLICATION_CREDENTIALS PULUMI_ACCESS_TOKEN AWS_PROFILE AWS_SESSION_TOKEN AWS_DEFAULT_PROFILE
export PULUMI_SKIP_UPDATE_CHECK=true
export PULUMI_BACKEND_URL="file://${FILE_BACKEND_DIR}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
export AWS_ENDPOINT_URL="$FLOCI_URL"
export CLOUDSDK_CONFIG="$STATE/gcloud-empty"

log() { echo "[tutorial] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
}

# The job image must be in the local daemon, since the runner does not pull
# it: plywood's own image comes from `just images`, and nothing pushes it.
need_job_image() {
  docker image inspect "$JOB_IMAGE" >/dev/null 2>&1 && return 0
  case "$JOB_IMAGE" in
    ghcr.io/intentius/plywood-*) die "the job image $JOB_IMAGE is not in the local Docker daemon; run 'just images' first, or set PLYWOOD_TUTORIAL_JOB_IMAGE" ;;
    *) die "the job image $JOB_IMAGE is not in the local Docker daemon; docker pull it, or set PLYWOOD_TUTORIAL_JOB_IMAGE" ;;
  esac
}

wait_http() { # url, label, tries (2s apart)
  local i code
  for i in $(seq 1 "$3"); do
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then log "$2 answered ($code) after ~$((i * 2))s"; return 0; fi
    sleep 2
  done
  "${COMPOSE[@]}" logs --tail=60 >&2 || true
  die "$2 did not answer on $1"
}

# Pulumi in a container on the bench's network, as the host user, with the
# example repository at /shop and the file:// backend at /backend. Only the
# variables named here reach it.
pulumi_run() { # backend (file|s3), then the command run with sh -c in /shop
  local backend_url
  case "$1" in
    file) backend_url="file:///backend" ;;
    s3) backend_url="$S3_BACKEND_NET" ;;
    *) die "unknown backend '$1' (file, s3)" ;;
  esac
  shift
  mkdir -p "$FILE_BACKEND_DIR"
  docker run --rm --network "$NETWORK" \
    --user "$(id -u):$(id -g)" \
    -v "$STATE/$REPO_NAME:/shop" -v "$FILE_BACKEND_DIR:/backend" -w /shop \
    -e HOME=/tmp/home -e PULUMI_HOME=/tmp/home/.pulumi \
    -e PULUMI_SKIP_UPDATE_CHECK=true \
    -e PULUMI_BACKEND_URL="$backend_url" \
    -e PULUMI_CONFIG_PASSPHRASE="$PASSPHRASE" \
    -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e AWS_ENDPOINT_URL="$FLOCI_NET_URL" \
    -e CLOUDSDK_CONFIG=/tmp/gcloud-empty \
    -e npm_config_cache=/tmp/home/.npm \
    --entrypoint sh "$PULUMI_IMAGE" -c "mkdir -p /tmp/home /tmp/gcloud-empty && $*"
}
