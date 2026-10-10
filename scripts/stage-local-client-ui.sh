#!/bin/bash
# Test builds only: build the Rocket Pool app of an AVADO-Client-UI checkout
# and stage its dist in build/client-ui-dist/, for
# `docker compose build --build-arg CLIENT_UI_SOURCE=local`.
# Releases never use this: the default CLIENT_UI_SOURCE=git builds the UI tag
# pinned in build/Dockerfile (CLIENT_UI_VERSION).
#
# Usage: scripts/stage-local-client-ui.sh /path/to/AVADO-Client-UI
set -euo pipefail

UI_DIR=${1:?usage: $0 /path/to/AVADO-Client-UI}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DEST="${REPO_DIR}/build/client-ui-dist"

(cd "${UI_DIR}" && yarn install --frozen-lockfile && yarn build:rocketpool)
test -f "${UI_DIR}/dist-rocketpool/index.html"

mkdir -p "${DEST}"
find "${DEST}" -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
cp -R "${UI_DIR}/dist-rocketpool/." "${DEST}/"

echo "Staged $(git -C "${UI_DIR}" describe --tags --always --dirty 2>/dev/null || echo "${UI_DIR}") in ${DEST}"
echo "Build with: docker compose build --build-arg CLIENT_UI_SOURCE=local"
