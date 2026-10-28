#!/usr/bin/env bash
#
# The tutorial bench: a local Forgejo with a runner, the floci AWS emulator,
# and the repository tutor/shop holding the plunge corpus's aws-ts program
# with stacks dev, staging, prod-us and prod-eu. The tutorial pages and the
# claims runs (plywood#22) use it.
#
#   stack/tutorial.sh up                     start the bench and seed it (just tutorial-up)
#   stack/tutorial.sh down                   remove its containers, network and volumes (just tutorial-down)
#   stack/tutorial.sh reset                  down, set the state dir aside, then up (just tutorial-reset)
#   stack/tutorial.sh preview [stack] [file|s3]
#                                            pulumi preview of a stack (default dev) inside the bench,
#                                            against the file:// backend or the S3 backend on floci
#   stack/tutorial.sh scan                   look for real-cloud and Pulumi Cloud hosts in the bench's logs
#
# Everything is named plywood-tutorial (compose project, network, containers,
# volumes). Files go to stack/.state (PLYWOOD_TUTORIAL_STATE), which git
# ignores; `down` leaves them, and `reset` moves them to stack/.state.<time>.
# stack/lib.sh holds the ports, names and pins.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

up() {
  need_docker
  need_job_image
  local started
  started=$(date +%s)
  log "starting Forgejo, its runner and floci (compose project $PROJECT)…"
  "${COMPOSE[@]}" up -d >&2
  "$STACK_DIR/seed.sh"
  log "ready in $(( $(date +%s) - started ))s"
  cat <<EOF

  Forgejo   $FORGEJO_URL   user $TUTOR_USER, password $TUTOR_PW, repository $TUTOR_USER/$REPO_NAME
  floci     $FLOCI_URL   the AWS API every stack talks to (keys test/test)
  bucket    s3://$BUCKET on floci   the self-managed backend

  Stacks: ${STACKS[*]}
  Host env: source $STATE/tutorial.env
EOF
}

down() {
  need_docker
  log "removing the bench's containers, network and volumes…"
  # Job containers the runner started and has not cleaned up sit on the
  # bench's network outside the compose project; take them off first so the
  # network can go.
  local jobs
  jobs="$(docker ps -aq --filter "network=$NETWORK" || true)"
  for c in $jobs; do
    case "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null)" in
      "$PROJECT") ;;
      *) docker container rm -f "$c" >/dev/null 2>&1 || true ;;
    esac
  done
  "${COMPOSE[@]}" down --volumes --remove-orphans >&2
  log "down; files under $STATE are kept"
}

reset() {
  down
  if [ -d "$STATE" ]; then
    local aside
    aside="$STATE.$(date +%Y%m%d-%H%M%S)"
    mv "$STATE" "$aside"
    log "moved the old state to $aside"
  fi
  up
}

preview() { # [stack] [file|s3]
  need_docker
  local stack="${1:-dev}" backend="${2:-file}" logf
  [ -d "$STATE/$REPO_NAME" ] || die "no example repository under $STATE; run 'just tutorial-up' first"
  mkdir -p "$STATE/logs"
  logf="$STATE/logs/preview-$stack-$backend.log"
  log "pulumi preview --stack $stack on the $backend backend (log: $logf)…"
  pulumi_run "$backend" "npm ci --no-audit --no-fund && pulumi preview --stack $stack --non-interactive --diff" 2>&1 | tee "$logf"
}

# URLs a bench run must never call: AWS, Google Cloud, Azure, Pulumi Cloud.
# Only URLs count, since the program's IAM policy names the service principal
# ec2.amazonaws.com and a preview prints it.
REAL_HOSTS='https?://[A-Za-z0-9.-]*(amazonaws\.com|googleapis\.com|azure\.com|windows\.net|api\.pulumi\.com|app\.pulumi\.com)'

scan() {
  need_docker
  local out="$STATE/scan.txt" found=0
  mkdir -p "$STATE/logs"
  "${COMPOSE[@]}" logs --no-color > "$out" 2>&1 || true
  cat "$STATE"/logs/*.log >> "$out" 2>/dev/null || true
  if grep -nE "$REAL_HOSTS" "$out" >&2; then found=1; fi
  if [ "$found" = 1 ]; then die "a real-cloud or Pulumi Cloud host appears in the bench's logs (above)"; fi
  log "no real-cloud or Pulumi Cloud host in the container logs or $STATE/logs"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  preview) shift; preview "$@" ;;
  scan) scan ;;
  *) echo "usage: stack/tutorial.sh up|down|reset|preview [stack] [file|s3]|scan" >&2; exit 2 ;;
esac
