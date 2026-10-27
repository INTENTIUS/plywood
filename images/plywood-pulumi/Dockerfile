# Rendered from packages/plywood/src/images.ts by packages/plywood/scripts/build-images.mjs.
# Edit the module, then run npm run images -w @intentius/plywood. Build from the repository root
# after npm run build (just images); nothing pushes it.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fetch
ARG TARGETARCH
ARG CHECKSUMS_URL=https://github.com/pulumi/pulumi/releases/download/v3.272.0/pulumi-3.272.0-checksums.txt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -e; a="$(case "$TARGETARCH" in arm64) echo arm64 ;; *) echo x64 ;; esac)" && f="pulumi-v3.272.0-linux-$a.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/pulumi/pulumi/releases/download/v3.272.0/$f" && curl -fsSLo "$t/sums" "$CHECKSUMS_URL" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "pulumi 3.272.0: $f is not in pulumi-3.272.0-checksums.txt" >&2; exit 1; }; } && case "$a" in x64) want=58d545f2b98761051922008ebd381ecef95484d7f7a5ff7faa15d7a780ea84f6 ;; arm64) want=4f0741901b8982c4326b702dabf483c63d2cf77c88ac42dd752b72541284a534 ;; *) want= ;; esac && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "pulumi 3.272.0: pulumi-3.272.0-checksums.txt lists $line for $f; plywood pins $want" >&2; exit 1; }; } && echo "$line  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/out/opt/plywood/pulumi-3.272.0" && tar -xzf "$t/$f" -C "/out/opt/plywood/pulumi-3.272.0" --strip-components=1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV USER=plywood HOME=/tmp PULUMI_HOME=/opt/plywood/pulumi-home PULUMI_SKIP_UPDATE_CHECK=true
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git config --system --add safe.directory '*' && mkdir -p /opt/plywood/pulumi-home && chmod 1777 /opt/plywood/pulumi-home
COPY --from=fetch /out/opt/plywood/ /opt/plywood/
RUN ln -s /opt/plywood/pulumi-3.272.0/pulumi /usr/local/bin/pulumi && pulumi version
COPY --chmod=0755 packages/plywood/dist/plywood.mjs /usr/local/bin/plywood
LABEL org.opencontainers.image.title="plywood-pulumi"
LABEL org.opencontainers.image.description="Pulumi 3.272.0 and the plywood CLI"
LABEL org.opencontainers.image.version="0.0.0"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/plywood"
LABEL org.opencontainers.image.licenses="Apache-2.0"
CMD ["bash"]
