#!/usr/bin/env bash
#
# Fill a running tutorial bench (stack/compose.yml): the backend bucket on
# floci, the user tutor with a token, the runner's registration, and the
# repository tutor/shop holding the plunge corpus's aws-ts program with the
# stacks dev, staging, prod-us and prod-eu, initialised in the S3 backend on
# floci and in the file:// backend under the state dir.
#
#   stack/seed.sh        stack/tutorial.sh up runs it after `docker compose up`
#
# Re-running it is safe: the bucket, the user, a token that still works, a
# runner that is online, the repository and the stacks are each kept.
#
# It writes $STATE/tutorial.env (export lines for the host: the file://
# backend, floci's endpoint, test keys, an empty CLOUDSDK_CONFIG, the forge's
# address and tutor's token). Progress goes to stderr.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

need_docker
command -v jq >/dev/null 2>&1 || die "jq is not installed"
command -v git >/dev/null 2>&1 || die "git is not installed"
mkdir -p "$STATE" "$STATE/logs" "$CLOUDSDK_CONFIG" "$FILE_BACKEND_DIR"

wait_http "$FLOCI_URL/" "floci" 60
wait_http "$FORGEJO_URL/api/v1/version" "Forgejo" 90

# ── the backend bucket ─────────────────────────────────────────────────────
# CreateBucket signed with the test keys (curl's SigV4). 409 means the bucket
# is there already.
log "creating s3://$BUCKET on floci (an existing one is kept)…"
code="$(curl -s -o "$STATE/logs/create-bucket.xml" -w '%{http_code}' -X PUT \
  --aws-sigv4 "aws:amz:us-east-1:s3" --user "test:test" "$FLOCI_URL/$BUCKET" || true)"
case "$code" in
  200|409) ;;
  *) die "floci answered ${code:-nothing} to CreateBucket $BUCKET: $(cat "$STATE/logs/create-bucket.xml" 2>/dev/null)" ;;
esac

# ── the user tutor ─────────────────────────────────────────────────────────
# An admin, since registering the runner is an admin call.
if ! curl -fs -o /dev/null -u "$TUTOR_USER:$TUTOR_PW" "$FORGEJO_URL/api/v1/user"; then
  log "creating the user $TUTOR_USER…"
  "${COMPOSE[@]}" exec -T -u git forgejo forgejo admin user create \
    --admin --username "$TUTOR_USER" --password "$TUTOR_PW" \
    --email "$TUTOR_EMAIL" --must-change-password=false >&2
fi

TOKEN=""
[ -f "$STATE/tutorial.env" ] && TOKEN="$(sed -n 's/^export PLYWOOD_TUTORIAL_FORGEJO_TOKEN=//p' "$STATE/tutorial.env")"
if [ -n "$TOKEN" ] && [ "$(curl -fsS -H "Authorization: token $TOKEN" "$FORGEJO_URL/api/v1/user" 2>/dev/null | jq -r '.login // empty')" = "$TUTOR_USER" ]; then
  log "keeping $TUTOR_USER's API token, which still works"
else
  log "minting an API token for $TUTOR_USER…"
  curl -s -o /dev/null -u "$TUTOR_USER:$TUTOR_PW" -X DELETE \
    "$FORGEJO_URL/api/v1/users/$TUTOR_USER/tokens/plywood-tutorial" || true
  TOKEN="$(curl -fsS -u "$TUTOR_USER:$TUTOR_PW" -H 'content-type: application/json' \
    -d '{"name":"plywood-tutorial","scopes":["all"]}' \
    "$FORGEJO_URL/api/v1/users/$TUTOR_USER/tokens" | jq -r '.sha1')"
  [ -n "$TOKEN" ] && [ "$TOKEN" != null ] || die "could not mint a token for $TUTOR_USER"
fi
api() { curl -fsS -H "Authorization: token $TOKEN" "$@"; }

# ── the runner ─────────────────────────────────────────────────────────────
# Forgejo 16 / forgejo-runner 13: create the runner on the server, which
# returns a uuid and a token, and name that pair in the runner's config. The
# config puts every job container on the bench's network and gives every job
# the bench's AWS and Pulumi environment, the way a CI runner in a real
# account carries that account's: floci, test keys, the S3 backend on floci,
# no update check, an empty gcloud config.
runner_online() {
  api "$FORGEJO_URL/api/v1/admin/actions/runners" \
    | jq -e --arg n "$RUNNER_NAME" 'map(select(.name == $n and .status != "offline")) | length > 0' >/dev/null 2>&1
}
if "${COMPOSE[@]}" exec -T runner grep -q PULUMI_BACKEND_URL /data/config.yml 2>/dev/null && runner_online; then
  log "the runner is already registered and online"
else
  for stale in $(api "$FORGEJO_URL/api/v1/admin/actions/runners" \
      | jq -r --arg n "$RUNNER_NAME" '.[] | select(.name == $n and .status == "offline") | .id'); do
    api -o /dev/null -X DELETE "$FORGEJO_URL/api/v1/admin/actions/runners/$stale" || true
  done
  log "registering the runner…"
  reg="$(api -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$RUNNER_NAME\",\"description\":\"plywood tutorial bench, docker executor\"}" \
    "$FORGEJO_URL/api/v1/admin/actions/runners")"
  runner_uuid="$(echo "$reg" | jq -r '.uuid')"
  runner_token="$(echo "$reg" | jq -r '.token')"
  [ -n "$runner_uuid" ] && [ "$runner_uuid" != null ] || die "runner creation returned no uuid: $reg"

  "${COMPOSE[@]}" exec -T runner sh -c 'cat > /data/config.yml.new && mv /data/config.yml.new /data/config.yml' <<EOF
log:
  level: info
  job_level: info
runner:
  file: /data/.runner
  capacity: ${RUNNER_CAPACITY}
  timeout: 30m
  shutdown_timeout: 0s
  fetch_interval: 1s
  report_interval: 1s
  envs:
    AWS_ENDPOINT_URL: ${FLOCI_NET_URL}
    AWS_ACCESS_KEY_ID: test
    AWS_SECRET_ACCESS_KEY: test
    AWS_REGION: us-east-1
    PULUMI_BACKEND_URL: "${S3_BACKEND_NET}"
    PULUMI_CONFIG_PASSPHRASE: ${PASSPHRASE}
    PULUMI_SKIP_UPDATE_CHECK: "true"
    CLOUDSDK_CONFIG: /tmp/plywood-tutorial-gcloud-empty
  labels:
    - "docker:docker://${JOB_IMAGE}"
    - "ubuntu-latest:docker://${JOB_IMAGE}"
cache:
  enabled: false
container:
  network: ${NETWORK}
  privileged: false
  options: ""
  valid_volumes: []
  docker_host: "-"
  force_pull: false
server:
  connections:
    forgejo:
      url: ${FORGEJO_NET_URL}/
      uuid: ${runner_uuid}
      token: ${runner_token}
EOF
  "${COMPOSE[@]}" restart runner >&2
  log "waiting for the runner to come online…"
  for i in $(seq 1 60); do
    runner_online && { log "runner online after ~$((i * 2))s"; break; }
    sleep 2
    if [ "$i" = 60 ]; then "${COMPOSE[@]}" logs --tail=60 runner >&2 || true; die "the runner did not come online"; fi
  done
fi

# ── the example repository ─────────────────────────────────────────────────
SHOP="$STATE/$REPO_NAME"
if [ ! -d "$SHOP/.git" ]; then
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
      [ -d "$src/.git" ] || git clone -q --filter=blob:none --no-checkout "$PLUNGE_URL" "$src" >&2
      git -C "$src" fetch -q origin "$PLUNGE_REF" >&2 || die "could not fetch plunge $PLUNGE_REF"
    fi
  fi
  log "taking $CORPUS_PATH from plunge ${PLUNGE_REF:0:10} ($src)…"
  mkdir -p "$SHOP"
  git -C "$src" archive "$PLUNGE_REF" \
      "$CORPUS_PATH/index.ts" "$CORPUS_PATH/package.json" "$CORPUS_PATH/package-lock.json" "$CORPUS_PATH/tsconfig.json" \
    | tar -x -C "$SHOP" --strip-components=3

  cat > "$SHOP/Pulumi.yaml" <<EOF
name: shop
description: The plywood tutorial's example, the aws-ts program of plunge's corpus (INTENTIUS/plunge $CORPUS_PATH at ${PLUNGE_REF:0:10})
runtime:
  name: nodejs
  options:
    typescript: true
    packagemanager: npm
EOF
  printf 'node_modules/\nbin/\n' > "$SHOP/.gitignore"

  # Each stack's AWS goes to floci as a job on the bench's network sees it,
  # with the test key pair and the skip flags that keep the provider off STS
  # and the metadata API, as the corpus's own floci stack does.
  for s in "${STACKS[@]}"; do
    cat > "$SHOP/Pulumi.$s.yaml" <<EOF
config:
  aws:region: $(stack_region "$s")
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
EOF
  done
fi

# Each stack in both backends. stack init adds the passphrase salt to the
# stack file on first use; a stack that exists is selected and kept.
log "initialising the stacks in the S3 backend on floci and the file:// backend…"
init_cmd=""
for s in "${STACKS[@]}"; do
  init_cmd="$init_cmd (pulumi stack select $s >/dev/null 2>&1 || pulumi stack init $s --secrets-provider passphrase) &&"
done
pulumi_run s3 "$init_cmd true" >"$STATE/logs/seed-stacks-s3.log" 2>&1 \
  || { cat "$STATE/logs/seed-stacks-s3.log" >&2; die "the stacks did not initialise in the S3 backend"; }
pulumi_run file "$init_cmd true" >"$STATE/logs/seed-stacks-file.log" 2>&1 \
  || { cat "$STATE/logs/seed-stacks-file.log" >&2; die "the stacks did not initialise in the file:// backend"; }

log "creating $TUTOR_USER/$REPO_NAME (an existing one is kept)…"
if ! api -o /dev/null "$FORGEJO_URL/api/v1/repos/$TUTOR_USER/$REPO_NAME" 2>/dev/null; then
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "{\"name\":\"$REPO_NAME\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" \
    "$FORGEJO_URL/api/v1/user/repos"
fi
api -o /dev/null -H 'content-type: application/json' -X PATCH \
  -d '{"has_actions":true}' "$FORGEJO_URL/api/v1/repos/$TUTOR_USER/$REPO_NAME"

if [ ! -d "$SHOP/.git" ]; then
  git -C "$SHOP" init -q -b main
  git -C "$SHOP" add -A
  git -C "$SHOP" -c user.name="$TUTOR_USER" -c user.email="$TUTOR_EMAIL" \
    commit -q -m "The aws-ts program from plunge's corpus, with stacks dev, staging, prod-us and prod-eu"
fi
# An empty repository takes the first push; one with history is left alone.
if [ "$(api "$FORGEJO_URL/api/v1/repos/$TUTOR_USER/$REPO_NAME" | jq -r '.empty')" = true ]; then
  log "pushing $TUTOR_USER/$REPO_NAME…"
  git -C "$SHOP" push -q "http://$TUTOR_USER:$TOKEN@127.0.0.1:$FORGEJO_PORT/$TUTOR_USER/$REPO_NAME.git" main >&2
fi

# ── the env file ───────────────────────────────────────────────────────────
tmp="$STATE/tutorial.env.$$"
cat > "$tmp" <<EOF
unset GOOGLE_APPLICATION_CREDENTIALS PULUMI_ACCESS_TOKEN AWS_PROFILE AWS_SESSION_TOKEN AWS_DEFAULT_PROFILE
export PULUMI_SKIP_UPDATE_CHECK=true
export PULUMI_BACKEND_URL=file://$FILE_BACKEND_DIR
export PULUMI_CONFIG_PASSPHRASE=$PASSPHRASE
export AWS_ENDPOINT_URL=$FLOCI_URL
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
export CLOUDSDK_CONFIG=$CLOUDSDK_CONFIG
export PLYWOOD_TUTORIAL_FORGEJO_URL=$FORGEJO_URL
export PLYWOOD_TUTORIAL_FORGEJO_TOKEN=$TOKEN
export PLYWOOD_TUTORIAL_S3_BACKEND='$S3_BACKEND_HOST'
EOF
mv "$tmp" "$STATE/tutorial.env"
log "wrote $STATE/tutorial.env"
