# Rendered from packages/plywood/src/images.ts by packages/plywood/scripts/build-images.mjs.
# Edit the module, then run npm run images -w @intentius/plywood. Build from the repository root
# after npm pack -w @intentius/plywood --pack-destination images/pack (just images); nothing pushes it.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fetch
ARG TARGETARCH
ARG CHECKSUMS_URL=https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.1.0/plunge-v0.1.0-checksums.txt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -e; a="$(case "$TARGETARCH" in (arm64) echo arm64 ;; (*) echo x64 ;; esac)" && f="plunge-v0.1.0-linux-$a.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.1.0/$f" && curl -fsSLo "$t/sums" "$CHECKSUMS_URL" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "plunge 0.1.0: $f is not in plunge-v0.1.0-checksums.txt" >&2; exit 1; }; } && case "$a" in x64) want=22b89da39ab7dc11268c7b625fec3d99c0793c9c47bf8d031fa94e6967ee8187 ;; arm64) want=6855611b8cf8381d73f5ddf0b5c0a0d83bdc2a5bd8c50d415e52bb05a4574f83 ;; *) want= ;; esac && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "plunge 0.1.0: plunge-v0.1.0-checksums.txt lists $line for $f; plywood pins $want" >&2; exit 1; }; } && echo "$line  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/out/opt/plywood/plunge-0.1.0" && tar -xzf "$t/$f" -C "/out/opt/plywood/plunge-0.1.0" --strip-components=1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV USER=plywood HOME=/tmp PULUMI_HOME=/opt/plywood/pulumi-home PULUMI_SKIP_UPDATE_CHECK=true
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git config --system --add safe.directory '*' && mkdir -p /opt/plywood/pulumi-home && chmod 1777 /opt/plywood/pulumi-home
COPY --from=fetch /out/opt/plywood/ /opt/plywood/
RUN ln -s /opt/plywood/plunge-0.1.0/plunge /usr/local/bin/plunge && plunge version
COPY images/pack/intentius-plywood-0.0.0.tgz /tmp/intentius-plywood-0.0.0.tgz
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/intentius-plywood-0.0.0.tgz && rm -f /tmp/intentius-plywood-0.0.0.tgz && npm cache clean --force && plywood --version
LABEL org.opencontainers.image.title="plywood-plunge"
LABEL org.opencontainers.image.description="plunge 0.1.0 and the plywood CLI"
LABEL org.opencontainers.image.version="0.0.0"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/plywood"
LABEL org.opencontainers.image.licenses="Apache-2.0"
CMD ["bash"]
