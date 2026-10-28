#!/usr/bin/env bash
#
# Fill a running tutorial bench (stack/compose.yml): the backend bucket and
# plunge's record store on floci, the user tutor with a token, the runner's registration, and the
# repository tutor/shop holding the plunge corpus's aws-ts program with the
# stacks dev, staging, prod-us and prod-eu, initialised in the S3 backend on
# floci and in the file:// backend under the state dir.
#
#   stack/seed.sh        stack/tutorial.sh up runs it after `docker compose up`
#
# The repository itself comes from stack/seed-repo.sh, which e2e/seed.ts runs
# too when the bench runs on chant's e2e harness (plywood#25).
#
# Re-running it is safe: the buckets, the user, a token that still works, a
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
command -v openssl >/dev/null 2>&1 || die "openssl is not installed"
mkdir -p "$STATE" "$STATE/logs" "$CLOUDSDK_CONFIG" "$FILE_BACKEND_DIR"

wait_http "$FLOCI_URL/" "floci" 60
wait_http "$FORGEJO_URL/api/v1/version" "Forgejo" 90

# ── the buckets ────────────────────────────────────────────────────────────
# Signed with the test keys (curl's SigV4). 409 on CreateBucket means the
# bucket is there already. The stock backend's bucket and plunge's record
# store both get the settings plunge+s3:// checks on open (plunge#20, #34),
# the ones plunge's races set (scripts/plunge-races/lib.sh secure_bucket):
# versioning, a lifecycle rule expiring noncurrent versions after 30 days,
# and all four public access blocks. A bare bucket is refused by plunge's
# store, so tutorial/plunge.mdx's store works only on these.
s3() { # method, path and query, body file (or ""), then the label
  local args=(-s -o "$STATE/logs/s3.xml" -w '%{http_code}' -X "$1" --aws-sigv4 "aws:amz:us-east-1:s3" --user "test:test")
  if [ -n "$3" ]; then
    args+=(-H "Content-Type: application/xml" -H "Content-MD5: $(openssl dgst -md5 -binary "$3" | openssl base64)" --data-binary "@$3")
  fi
  curl "${args[@]}" "$FLOCI_URL/$2" || true
}
secure_bucket() { # bucket
  local f code
  log "creating s3://$1 on floci with versioning, a lifecycle rule and the public access blocks (an existing one is kept)…"
  code="$(s3 PUT "$1" "" create)"
  case "$code" in 200|409) ;; *) die "floci answered ${code:-nothing} to CreateBucket $1: $(cat "$STATE/logs/s3.xml" 2>/dev/null)" ;; esac
  f="$STATE/logs/s3-body.xml"
  printf '%s' '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' > "$f"
  code="$(s3 PUT "$1?versioning" "$f")"; [ "$code" = 200 ] || die "floci answered ${code:-nothing} to PutBucketVersioning $1"
  printf '%s' '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>records-noncurrent</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>' > "$f"
  code="$(s3 PUT "$1?lifecycle" "$f")"; [ "$code" = 200 ] || die "floci answered ${code:-nothing} to PutBucketLifecycleConfiguration $1"
  printf '%s' '<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>' > "$f"
  code="$(s3 PUT "$1?publicAccessBlock" "$f")"; [ "$code" = 200 ] || die "floci answered ${code:-nothing} to PutPublicAccessBlock $1"
}
secure_bucket "$BUCKET"
secure_bucket "$PLUNGE_BUCKET"

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
"$STACK_DIR/seed-repo.sh" "$SHOP"

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
export PLYWOOD_TUTORIAL_PLUNGE_STORE='$PLUNGE_STORE_HOST'
EOF
mv "$tmp" "$STATE/tutorial.env"
log "wrote $STATE/tutorial.env"
