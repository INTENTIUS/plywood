# Rendered from dockerfiles in packages/plywood/src/images.ts by chant dev render.
# Edit the module, then run npm run images -w @intentius/plywood. Build from the repository root
# after npm pack -w @intentius/plywood --pack-destination images/pack, with --build-arg CHANT_RELEASE_LABEL=<the packed version>
# (just images passes the committed one; a release passes its label); nothing pushes it.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fetch
ARG TARGETARCH
ARG CHECKSUMS_URL=https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.2.0/plunge-v0.2.0-checksums.txt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=x64 ;; (arm64) w=arm64 ;; (*) echo "plunge 0.2.0: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="plunge-v0.2.0-linux-$w.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.2.0/$f" && case "$a" in (amd64) want=c9c73d05cca9ad214b7f44230a6162cdcb6ad64bbfc725bc94688b997b191495 ;; (arm64) want=c176a82f038164085aa19c8ad6530d6022e560e124050e535dbe364ae0473357 ;; (*) want= ;; esac && curl -fsSLo "$t/sums" "$CHECKSUMS_URL" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "plunge 0.2.0: $f is not in plunge-v0.2.0-checksums.txt" >&2; exit 1; }; } && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "plunge 0.2.0: plunge-v0.2.0-checksums.txt lists $line for $f; chant records $want" >&2; exit 1; }; } && want="$line" && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/plywood/plunge-0.2.0" && tar -xzf "$t/$f" -C "/opt/plywood/plunge-0.2.0" --strip-components=1
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=x86_64 ;; (arm64) w=aarch64 ;; (*) echo "aws-cli 2.22.0: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="awscli-exe-linux-$w-2.22.0.zip" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://awscli.amazonaws.com/$f" && case "$a" in (amd64) want=f315aa564190a12ae05a05bd8ab7b0645dd4a1ad71ce9e47dae4ff3dfeee8ceb ;; (arm64) want=c932ac00901ea3c430f3829140b8dc00fa6e9b8b99d6891929a4795947de7f3e ;; (*) want= ;; esac && { [ -n "$want" ] || { echo "aws-cli 2.22.0: no sha256 is recorded for $f" >&2; exit 1; }; } && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/plywood/aws-cli-2.22.0" && unzip -q "$t/$f" -d "$t" && "$t/aws/install" -i "/opt/plywood/aws-cli-2.22.0" -b "/opt/plywood/aws-cli-2.22.0/bin"
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG CHANT_RELEASE_LABEL
ENV USER=plywood
ENV HOME=/tmp
ENV NODE_DISABLE_COMPILE_CACHE=1
ENV npm_config_logs_max=0
ENV PULUMI_HOME=/opt/plywood/pulumi-home
ENV PULUMI_SKIP_UPDATE_CHECK=true
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
RUN git config --system --add safe.directory '*'
COPY --from=fetch /opt/plywood/ /opt/plywood/
RUN ln -sf /opt/plywood/plunge-0.2.0/plunge /usr/local/bin/plunge && ln -sf /opt/plywood/aws-cli-2.22.0/v2/current/bin/aws /usr/local/bin/aws
RUN mkdir -p /opt/plywood/pulumi-home && chmod 1777 /opt/plywood/pulumi-home && plunge version && aws --version
RUN plunge plugin install resource command 1.0.1 && chmod -R a+rX /opt/plywood/pulumi-home
COPY images/pack/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && rm -f /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && npm cache clean --force && plywood --version
LABEL org.opencontainers.image.title="plywood-plunge"
LABEL org.opencontainers.image.description="plunge 0.2.0, the AWS CLI 2.22.0 and the plywood CLI"
LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/plywood"
LABEL org.opencontainers.image.licenses="Apache-2.0"
CMD ["bash"]
