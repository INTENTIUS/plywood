# Rendered from dockerfiles in packages/plywood/src/images.ts by chant dev render.
# Edit the module, then run npm run images -w @intentius/plywood. Build from the repository root
# after npm pack -w @intentius/plywood --pack-destination images/pack, with --build-arg CHANT_RELEASE_LABEL=<the packed version>
# (just images passes the committed one; a release passes its label); nothing pushes it.
FROM cgr.dev/chainguard/wolfi-base:latest@sha256:be019c1c74fe69204a42c4e10bc4d886a49bf5403ffa74374ef7baa408fc9a26 AS fetch
ARG TARGETARCH
ARG CHECKSUMS_URL=https://github.com/pulumi/pulumi/releases/download/v3.277.0/pulumi-3.277.0-checksums.txt
RUN apk add --no-cache ca-certificates=20261020-r0 curl=8.23.0-r4 unzip=6.0-r9 || { echo "apk add failed. If Wolfi no longer serves a pinned version, move the pin: a newer chant moves its own (WOLFI_PACKAGE_PINS), and chant release images --repin <file> moves an apk:<name>=<version> entry in your source; then render this Dockerfile again." >&2; exit 1; }
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=x64 ;; (arm64) w=arm64 ;; (*) echo "pulumi 3.277.0: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="pulumi-v3.277.0-linux-$w.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/pulumi/pulumi/releases/download/v3.277.0/$f" && case "$a" in (amd64) want=1e38f0fb69a14a326cf3acfaf975770e8de5d0771042f26292f0013d237b8393 ;; (arm64) want=b9c2708bd13ffdcba79f555a0532893a9b5a44efca8e225d171b8f7b605b16ce ;; (*) want= ;; esac && curl -fsSLo "$t/sums" "$CHECKSUMS_URL" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "pulumi 3.277.0: $f is not in pulumi-3.277.0-checksums.txt" >&2; exit 1; }; } && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "pulumi 3.277.0: pulumi-3.277.0-checksums.txt lists $line for $f; chant records $want" >&2; exit 1; }; } && want="$line" && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/plywood/pulumi-3.277.0" && tar -xzf "$t/$f" -C "/opt/plywood/pulumi-3.277.0" --strip-components=1
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=x86_64 ;; (arm64) w=aarch64 ;; (*) echo "aws-cli 2.42.1: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="awscli-exe-linux-$w-2.42.1.zip" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://awscli.amazonaws.com/$f" && case "$a" in (amd64) want=ff2631c32c5db291b099600f404bc493454ec66c125ff4604625da90480c1f47 ;; (arm64) want=98f5f03bb6508a06ce9d9d6d2db97932dce735f3b7ad85616324a95edf4b815f ;; (*) want= ;; esac && { [ -n "$want" ] || { echo "aws-cli 2.42.1: no sha256 is recorded for $f" >&2; exit 1; }; } && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/plywood/aws-cli-2.42.1" && unzip -q "$t/$f" -d "$t" && "$t/aws/install" -i "/opt/plywood/aws-cli-2.42.1" -b "/opt/plywood/aws-cli-2.42.1/bin"
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
RUN apk add --no-cache git=2.56.1-r1 ca-certificates=20261020-r0 || { echo "apk add failed. If Wolfi no longer serves a pinned version, move the pin: a newer chant moves its own (WOLFI_PACKAGE_PINS), and chant release images --repin <file> moves an apk:<name>=<version> entry in your source; then render this Dockerfile again." >&2; exit 1; } && mkdir -p /usr/local/bin
RUN git config --system --add safe.directory '*'
COPY --from=fetch /opt/plywood/ /opt/plywood/
RUN ln -sf /opt/plywood/pulumi-3.277.0/pulumi /usr/local/bin/pulumi && ln -sf /opt/plywood/aws-cli-2.42.1/v2/current/bin/aws /usr/local/bin/aws
RUN mkdir -p /opt/plywood && chown 65532:65532 /opt/plywood
RUN mkdir -p /opt/plywood/pulumi-home && chmod 1777 /opt/plywood/pulumi-home && pulumi version && aws --version
RUN pulumi plugin install resource command 1.3.0 && chmod -R a+rX /opt/plywood/pulumi-home
COPY images/pack/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && rm -f /tmp/intentius-plywood-${CHANT_RELEASE_LABEL}.tgz && npm cache clean --force && plywood --version
LABEL org.opencontainers.image.title="plywood-pulumi"
LABEL org.opencontainers.image.description="Pulumi 3.277.0, the AWS CLI 2.42.1 and the plywood CLI, on Chainguard images"
LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/plywood"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.base.name="cgr.dev/chainguard/node:latest-dev"
LABEL org.opencontainers.image.base.digest="sha256:cd993dc8ec644f8f35e8356f6b442e807cdc5e42f303da5ce19a55d7cf660b51"
LABEL io.intentius.chant.image.base="chainguard"
ENTRYPOINT []
CMD ["bash"]
USER 65532
