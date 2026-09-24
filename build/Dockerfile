# AVADO Rocket Pool package image.
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.

ARG NODE_VERSION=22.23.2
# Where the Rocket Pool UI comes from: "git" (default, every release) clones
# AVADO-Client-UI at CLIENT_UI_VERSION and runs `yarn build:rocketpool`;
# "local" takes a prebuilt dist from build/client-ui-dist/
# (scripts/stage-local-client-ui.sh), for test builds of an unreleased UI only.
ARG CLIENT_UI_SOURCE=git

########## Rocket Pool UI (https://github.com/AvadoDServer/AVADO-Client-UI)
# Static files only, so this stage runs on the build host's platform.
FROM node:${NODE_VERSION}-bookworm-slim AS ui-git
ARG CLIENT_UI_VERSION=v0.2.0
ARG CLIENT_UI_REPO=https://github.com/AvadoDServer/AVADO-Client-UI
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${CLIENT_UI_VERSION} ${CLIENT_UI_REPO} /ui
WORKDIR /ui
RUN yarn install --frozen-lockfile && yarn build:rocketpool

FROM node:${NODE_VERSION}-bookworm-slim AS ui-local
COPY build/client-ui-dist /ui/dist-rocketpool

FROM ui-${CLIENT_UI_SOURCE} AS ui

########## Smartnode daemon: download and verify
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm AS smartnode
ARG RP_VERSION=v1.24.2
# sha256 of rocketpool-daemon-linux-amd64 from rocket-pool/smartnode release
# v1.24.2: the asset digest GitHub publishes for the release (checked with
# `gh release view v1.24.2 -R rocket-pool/smartnode --json assets`). Checked
# once more on 2026-09-23 by downloading the asset, hashing it, and verifying
# its .sig with the release's fornax-signing-key.asc
# (6D3E 960B D402 C646 42A1  EC84 6510 23D6 2E70 B5DD, "Good signature").
# Update both values together.
ARG RP_DAEMON_SHA256=823c75adcc452dd036e8d92257e81e85be67aaeba94432bd0e1576a86fd7c18e
RUN curl -fsSL --retry 3 -o /rocketpoold \
      "https://github.com/rocket-pool/smartnode/releases/download/${RP_VERSION}/rocketpool-daemon-linux-amd64" \
    && echo "${RP_DAEMON_SHA256}  /rocketpoold" | sha256sum -c - \
    && chmod 755 /rocketpoold

########## Backend (Task 2 owns build/backend)
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm AS backend
WORKDIR /usr/src/backend
COPY build/backend/package.json build/backend/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY build/backend/ ./
RUN yarn build \
    && yarn install --frozen-lockfile --production --ignore-scripts --prefer-offline

########## Runtime
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gettext-base supervisor \
    && rm -rf /var/lib/apt/lists/*

COPY --from=smartnode /rocketpoold /usr/local/bin/rocketpoold

# Package version (/srv/rocketpool/package-version). entrypoint.sh exports it
# as PACKAGE_VERSION for start-node.sh (upgrade backup marker) and the
# backend. It is read from the manifest instead of a build arg so an
# `avadosdk increase` bump can never leave it stale.
COPY dappnode_package.json /tmp/dappnode_package.json
RUN mkdir -p /srv/rocketpool/scripts \
    && node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/srv/rocketpool/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json

COPY build/entrypoint.sh build/start-node.sh build/signal-reconcile.sh build/user-settings.template /srv/rocketpool/
COPY build/scripts/ /srv/rocketpool/scripts/
RUN chmod 755 /srv/rocketpool/entrypoint.sh /srv/rocketpool/start-node.sh /srv/rocketpool/signal-reconcile.sh /srv/rocketpool/scripts/*.sh
COPY build/supervisord.conf /etc/supervisord.conf

COPY --from=backend /usr/src/backend /usr/src/backend
# Build-time check: the backend build actually produced its entry point.
RUN test -f /usr/src/backend/dist/server.js \
    || { echo "backend build did not produce /usr/src/backend/dist/server.js"; exit 1; }

# The UI, served by the backend (UI_DIR default /usr/local/ui).
COPY --from=ui /ui/dist-rocketpool /usr/local/ui
RUN rm -f /usr/local/ui/.gitkeep \
    && test -f /usr/local/ui/index.html \
    || { echo "Rocket Pool UI missing: /usr/local/ui/index.html"; exit 1; }

# Build-time check: Smartnode's own config loader accepts the rendered
# template (the same check start-node.sh runs on every start).
RUN NETWORK=mainnet EXECUTIONCLIENT=geth CONSENSUSCLIENT=teku bash -c '\
      . /srv/rocketpool/scripts/lib.sh \
      && SMARTNODE_VERSION="$(smartnode_version)" \
      && [ "$SMARTNODE_VERSION" = "1.24.2" ] \
      && resolve_client_urls \
      && config_preflight \
      || { echo "config preflight failed: ${PREFLIGHT_OUTPUT:-}"; exit 1; }'

WORKDIR /
# Exports PACKAGE_VERSION to both programs, then runs supervisord.
ENTRYPOINT ["/srv/rocketpool/entrypoint.sh"]
