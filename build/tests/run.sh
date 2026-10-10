#!/bin/bash
# Runs the build/ shell tests in the runtime image's Debian base (bash 5,
# GNU coreutils, envsubst). Use --local to run them in the current shell
# instead (needs bash >= 4.4 and envsubst).
set -eu
BUILD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = "--local" ]; then
    exec bash "$BUILD_DIR/tests/test-start-node.sh"
fi
exec docker run --rm --platform linux/amd64 -v "$BUILD_DIR:/build:ro" node:22.23.2-bookworm-slim bash -c '
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends gettext-base >/dev/null
    bash /build/tests/test-start-node.sh'
