# Rendered from dockerfiles in packages/plywood/src/images.ts by chant dev render.
# Edit the module, then run npm run images -w @intentius/plywood. Build from the repository root
# after npm pack -w @intentius/plywood --pack-destination images/pack, with --build-arg CHANT_RELEASE_LABEL=<the packed version>
# (just images passes the committed one; a release passes its label); nothing pushes it.
FROM cgr.dev/chainguard/wolfi-base:latest@sha256:be019c1c74fe69204a42c4e10bc4d886a49bf5403ffa74374ef7baa408fc9a26 AS fetch
ARG TARGETARCH
ARG CHECKSUMS_URL=https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.2.0/plunge-v0.2.0-checksums.txt
RUN apk add --no-cache ca-certificates curl unzip
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=x64 ;; (arm64) w=arm64 ;; (*) echo "plunge 0.2.0: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="plunge-v0.2.0-linux-$w.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.2.0/$f" && case "$a" in (amd64) want=c9c73d05cca9ad214b7f44230a6162cdcb6ad64bbfc725bc94688b997b191495 ;; (arm64) want=c176a82f038164085aa19c8ad6530d6022e560e124050e535dbe364ae0473357 ;; (*) want= ;; esac && curl -fsSLo "$t/sums" "$CHECKSUMS_URL" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "plunge 0.2.0: $f is not in plunge-v0.2.0-checksums.txt" >&2; exit 1; }; } && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "plunge 0.2.0: plunge-v0.2.0-checksums.txt lists $line for $f; chant records $want" >&2; exit 1; }; } && want="$line" && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/plywood/plunge-0.2.0" && tar -xzf "$t/$f" -C "/opt/plywood/plunge-0.2.0" --strip-components=1
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=x86_64 ;; (arm64) w=aarch64 ;; (*) echo "aws-cli 2.22.0: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="awscli-exe-linux-$w-2.22.0.zip" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://awscli.amazonaws.com/$f" && case "$a" in (amd64) want=f315aa564190a12ae05a05bd8ab7b0645dd4a1ad71ce9e47dae4ff3dfeee8ceb ;; (arm64) want=c932ac00901ea3c430f3829140b8dc00fa6e9b8b99d6891929a4795947de7f3e ;; (*) want= ;; esac && { [ -n "$want" ] || { echo "aws-cli 2.22.0: no sha256 is recorded for $f" >&2; exit 1; }; } && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/plywood/aws-cli-2.22.0" && unzip -q "$t/$f" -d "$t" && "$t/aws/install" -i "/opt/plywood/aws-cli-2.22.0" -b "/opt/plywood/aws-cli-2.22.0/bin"
FROM cgr.dev/chainguard/node:latest-dev@sha256:cd993dc8ec644f8f35e8356f6b442e807cdc5e42f303da5ce19a55d7cf660b51
USER root
ARG CHANT_RELEASE_LABEL
ENV USER=plywood
ENV HOME=/tmp
ENV NODE_DISABLE_COMPILE_CACHE=1
ENV npm_config_logs_max=0
ENV CHANT_IMAGE_USER=65532
ENV PULUMI_HOME=/opt/plywood/pulumi-home
ENV PULUMI_SKIP_UPDATE_CHECK=true
ENV PATH=/opt/plywood/bin:$PATH
RUN apk add --no-cache git ca-certificates && mkdir -p /usr/local/bin
RUN git config --system --add safe.directory '*'
COPY --from=fetch /opt/plywood/ /opt/plywood/
RUN ln -sf /opt/plywood/plunge-0.2.0/plunge /usr/local/bin/plunge && ln -sf /opt/plywood/aws-cli-2.22.0/v2/current/bin/aws /usr/local/bin/aws
RUN mkdir -p /opt/plywood && chown 65532:65532 /opt/plywood
RUN mkdir -p /opt/plywood/pulumi-home && chmod 1777 /opt/plywood/pulumi-home && plunge version && aws --version
RUN plunge plugin install resource command 1.0.1 && chmod -R a+rX /opt/plywood/pulumi-home
COPY images/pack/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && rm -f /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && npm cache clean --force && plywood --version
LABEL org.opencontainers.image.title="plywood-plunge"
LABEL org.opencontainers.image.description="plunge 0.2.0, the AWS CLI 2.22.0 and the plywood CLI, on Chainguard images"
LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/plywood"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.base.name="cgr.dev/chainguard/node:latest-dev"
LABEL org.opencontainers.image.base.digest="sha256:cd993dc8ec644f8f35e8356f6b442e807cdc5e42f303da5ce19a55d7cf660b51"
LABEL io.intentius.chant.image.base="chainguard"
ENTRYPOINT []
CMD ["bash"]
USER 65532
