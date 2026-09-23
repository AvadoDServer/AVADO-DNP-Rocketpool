#!/bin/bash
# Starts the Rocket Pool node daemon (supervisord program "rocketpool-node").
#
# 1. Validate NETWORK / EXECUTIONCLIENT / CONSENSUSCLIENT and build the EL/CL URLs.
# 2. On the first start of a new package version, back up wallet, password,
#    validator keys and old settings to /rocketpool/backups (keep newest 3).
# 3. Render a fresh native-mode user-settings.yml from the template.
# 4. Check that the daemon's config loader accepts it.
# 5. exec rocketpoold.
#
# Any failure before step 5 writes the reason to $STATUS_FILE (JSON) and
# /tmp/rocketpool-startup-error.txt (one plain line), both read by the
# backend and shown in the UI, and exits with 78, which supervisord treats as
# "expected": the daemon then stays stopped instead of restart-looping.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${LIB_FILE:-$SCRIPT_DIR/scripts/lib.sh}"

PACKAGE_VERSION="${PACKAGE_VERSION:-$(cat "$RP_DIR/package-version" 2>/dev/null)}"
SMARTNODE_VERSION="$(smartnode_version)"
DAEMON_LOG="${DAEMON_LOG-/var/log/rocketpool/daemon.log}"
STARTUP_ERROR_FILE="${STARTUP_ERROR_FILE:-/tmp/rocketpool-startup-error.txt}"

stop_with() {
    write_status "$1" "$2" "${BACKUP_PATH:-}"
    # One plain line for the backend / UI.
    printf '%s\n' "$2" | tr '\n' ' ' | sed 's/ *$//' >"$STARTUP_ERROR_FILE"
    echo >>"$STARTUP_ERROR_FILE"
    log "ERROR: $2"
    log "The Rocket Pool daemon stays stopped."
    exit "$EX_CONFIG"
}

# Log to stdout (docker logs) and to a size-limited file the backend can read.
if [ -n "$DAEMON_LOG" ]; then
    mkdir -p "$(dirname "$DAEMON_LOG")"
    exec > >("$SCRIPT_DIR/scripts/log-tee.sh" "$DAEMON_LOG") 2>&1
fi

# Throttle a crash loop: supervisord restarts the daemon immediately.
LAST_START_FILE="${LAST_START_FILE:-/tmp/rocketpool-node.last-start}"
if [ -f "$LAST_START_FILE" ]; then
    last="$(cat "$LAST_START_FILE" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [ $((now - ${last:-0})) -lt 30 ] 2>/dev/null; then
        log "Daemon restarted within 30s, waiting 30s"
        sleep 30
    fi
fi
date +%s >"$LAST_START_FILE"

BACKUP_PATH=""
if [ -z "$PACKAGE_VERSION" ]; then
    stop_with unsupported_config "Package version file $RP_DIR/package-version is missing (image build problem)."
fi
if [ -z "$SMARTNODE_VERSION" ]; then
    stop_with config_error "Could not read the version of $RP_BIN."
fi

if ! resolve_client_urls; then
    stop_with unsupported_config "$ERROR"
fi
log "Network $NETWORK, execution client $EXECUTIONCLIENT ($EC_HTTP_URL), consensus client $CONSENSUSCLIENT ($CC_HTTP_URL)"

mkdir -p "$DATA_DIR" || stop_with backup_failed "Could not create $DATA_DIR."
if ! backup_if_needed; then
    stop_with backup_failed "Backing up the wallet and keys before the upgrade failed (disk full?). Nothing was changed. Free up space and restart the package."
fi

if ! render_settings "$SETTINGS_FILE" "$DATA_DIR" "$EC_HTTP_URL" "$CC_HTTP_URL" "8280"; then
    stop_with config_error "Could not write $SETTINGS_FILE."
fi

if ! config_preflight; then
    log "Config preflight output:"
    printf '%s\n' "$PREFLIGHT_OUTPUT"
    stop_with config_error "Smartnode v$SMARTNODE_VERSION did not accept the generated settings: $(printf '%s' "$PREFLIGHT_OUTPUT" | grep -v '^$' | tail -n 3)"
fi
log "Settings accepted by Smartnode v$SMARTNODE_VERSION"

mkdir -p "$DATA_DIR/rewards-trees"
write_status starting "Starting the Rocket Pool daemon." "$BACKUP_PATH"
rm -f "$STARTUP_ERROR_FILE"

exec "$RP_BIN" --settings "$SETTINGS_FILE" node
