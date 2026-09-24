#!/bin/bash
# Shared functions for start-node.sh. Sourced, never executed directly.
# shellcheck disable=SC2034  # variables are used by the sourcing script
#
# Every path comes from a variable with a production default, so the tests can
# point the functions at a fixture directory.

RP_DIR="${RP_DIR:-/srv/rocketpool}"
DATA_DIR="${DATA_DIR:-/rocketpool/data}"
BACKUP_ROOT="${BACKUP_ROOT:-/rocketpool/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-3}"
STATUS_FILE="${STATUS_FILE:-/tmp/avado-start-status.json}"
VERSION_MARKER="${VERSION_MARKER:-${DATA_DIR}/.avado-package-version}"
FINGERPRINT_FILE="${FINGERPRINT_FILE:-${DATA_DIR}/.avado-backup-fingerprint}"
TEMPLATE_FILE="${TEMPLATE_FILE:-${RP_DIR}/user-settings.template}"
SETTINGS_FILE="${SETTINGS_FILE:-${RP_DIR}/user-settings.yml}"
RP_BIN="${RP_BIN:-/usr/local/bin/rocketpoold}"

# Exit code for "configuration problem, do not restart" (sysexits EX_CONFIG).
# supervisord lists it in exitcodes, so it leaves the daemon stopped.
EX_CONFIG=78

# Items in the data dir that the upgrade backup copies (if present).
BACKUP_DATA_ITEMS=(wallet password address validators custom-keys custom-key-passwords mnemonic transactions.json)
# Settings files the previous package version rendered. They live in the
# container filesystem, so they only exist when the same container restarts.
BACKUP_SETTINGS_ITEMS=("${RP_DIR}/user-settings.yml" "${RP_DIR}/settings.json")

log() {
    echo "[start-node] $*"
}

json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/}"
    s="${s//$'\t'/ }"
    printf '%s' "$s"
}

# write_status <state> <message> [backup_path]
# States: starting | unsupported_config | backup_failed | config_error |
#         config_check_retry (preflight timed out, retrying; daemon not started yet)
# Read by the backend (GET /api/avado/status). Never contains secrets.
write_status() {
    local state="$1" message="$2" backup="${3:-}"
    local tmp="${STATUS_FILE}.tmp"
    {
        printf '{\n'
        printf '  "state": "%s",\n' "$(json_escape "$state")"
        printf '  "message": "%s",\n' "$(json_escape "$message")"
        printf '  "time": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf '  "packageVersion": "%s",\n' "$(json_escape "${PACKAGE_VERSION:-}")"
        printf '  "smartnodeVersion": "%s",\n' "$(json_escape "${SMARTNODE_VERSION:-}")"
        printf '  "network": "%s",\n' "$(json_escape "${NETWORK:-}")"
        printf '  "executionClient": "%s",\n' "$(json_escape "${EXECUTIONCLIENT:-}")"
        printf '  "consensusClient": "%s",\n' "$(json_escape "${CONSENSUSCLIENT:-}")"
        printf '  "ecHttpUrl": "%s",\n' "$(json_escape "${EC_HTTP_URL:-}")"
        printf '  "ecWsUrl": "%s",\n' "$(json_escape "${EC_WS_URL:-}")"
        printf '  "ccHttpUrl": "%s",\n' "$(json_escape "${CC_HTTP_URL:-}")"
        printf '  "backup": "%s"\n' "$(json_escape "$backup")"
        printf '}\n'
    } >"$tmp" && mv -f "$tmp" "$STATUS_FILE"
}

# Validates NETWORK / EXECUTIONCLIENT / CONSENSUSCLIENT and sets
# EC_HTTP_URL, EC_WS_URL and CC_HTTP_URL. Hostnames and ports are the ones the
# 0.0.106 package used (audit 2a). Returns 1 with ERROR set on bad input.
resolve_client_urls() {
    ERROR=""
    if [ "${NETWORK:-}" != "mainnet" ]; then
        ERROR="Network '${NETWORK:-}' is not supported. Only mainnet is supported (Holesky and Prater are shut down). Set NETWORK=mainnet."
        return 1
    fi

    case "${EXECUTIONCLIENT:-}" in
    geth)
        EC_HTTP_URL="http://ethchain-geth.my.ava.do:8545"
        EC_WS_URL="ws://ethchain-geth.my.ava.do:8546"
        ;;
    nethermind)
        EC_HTTP_URL="http://avado-dnp-nethermind.my.ava.do:8545"
        EC_WS_URL="ws://avado-dnp-nethermind.my.ava.do:8545"
        ;;
    reth)
        EC_HTTP_URL="http://reth-mainnet.my.ava.do:8545"
        EC_WS_URL="ws://reth-mainnet.my.ava.do:8546"
        ;;
    *)
        ERROR="Execution client '${EXECUTIONCLIENT:-}' is not supported. Use geth, nethermind or reth."
        return 1
        ;;
    esac

    case "${CONSENSUSCLIENT:-}" in
    teku) CC_HTTP_URL="http://teku.my.ava.do:5051" ;;
    nimbus) CC_HTTP_URL="http://nimbus.my.ava.do:5052" ;;
    lighthouse) CC_HTTP_URL="http://lighthouse.my.ava.do:5052" ;;
    prysm) CC_HTTP_URL="http://prysm-beacon-chain-mainnet.my.ava.do:3500" ;;
    *)
        ERROR="Consensus client '${CONSENSUSCLIENT:-}' is not supported. Use teku, nimbus, lighthouse or prysm."
        return 1
        ;;
    esac
    return 0
}

# Prints the Smartnode version of the binary, e.g. "1.24.2".
smartnode_version() {
    "$RP_BIN" --version 2>/dev/null | sed -n 's/^rocketpool version \([0-9][0-9A-Za-z.+-]*\)$/\1/p' | head -n1
}

# render_settings <out_file> <data_path> <ec_url> <cc_url> <api_port>
# Only the listed variables are substituted, so any other "$" in the
# template stays literal.
render_settings() {
    local out="$1"
    local tmp="${out}.tmp"
    # shellcheck disable=SC2016  # envsubst's SHELL-FORMAT, not shell expansion
    SN_VERSION="v${SMARTNODE_VERSION}" \
        SN_NETWORK="$NETWORK" \
        SN_DATA_PATH="$2" \
        SN_RP_DIR="$RP_DIR" \
        SN_EXECUTION_CLIENT="$EXECUTIONCLIENT" \
        SN_CONSENSUS_CLIENT="$CONSENSUSCLIENT" \
        SN_EC_HTTP_URL="$3" \
        SN_CC_HTTP_URL="$4" \
        SN_API_PORT="$5" \
        envsubst '${SN_VERSION} ${SN_NETWORK} ${SN_DATA_PATH} ${SN_RP_DIR} ${SN_EXECUTION_CLIENT} ${SN_CONSENSUS_CLIENT} ${SN_EC_HTTP_URL} ${SN_CC_HTTP_URL} ${SN_API_PORT}' \
        <"$TEMPLATE_FILE" >"$tmp" || return 1
    mv -f "$tmp" "$out"
}

# Runs the daemon's own config loader against settings rendered from the same
# template, but with a throwaway data dir, unreachable EL/CL URLs and the API
# disabled. The daemon prints "Starting node daemon in Native Mode." right
# after the config loaded; then it can only wait for the (unreachable) EL, so
# it cannot touch the wallet or send anything. Sets PREFLIGHT_OUTPUT.
# Returns 0 when the config loaded, 1 when the daemon exited without loading
# it (rejected), 2 when it was still running after $PREFLIGHT_TIMEOUT
# seconds without printing either (slow box: retry, don't give up).
config_preflight() {
    local dir
    dir="$(mktemp -d /tmp/rp-preflight.XXXXXX)" || return 1
    mkdir -p "$dir/data"
    local settings="$dir/user-settings.yml"
    if ! render_settings "$settings" "$dir/data" "http://127.0.0.1:1" "http://127.0.0.1:1" "0"; then
        PREFLIGHT_OUTPUT="could not render the preflight settings"
        rm -rf "$dir"
        return 1
    fi

    "$RP_BIN" --settings "$settings" node >"$dir/out.log" 2>&1 &
    local pid=$! ok=1
    for _ in $(seq 1 "${PREFLIGHT_TIMEOUT:-60}"); do
        if grep -q "Starting node daemon in Native Mode." "$dir/out.log"; then
            ok=0
            break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    if [ "$ok" -ne 0 ]; then
        if grep -q "Starting node daemon in Native Mode." "$dir/out.log"; then
            ok=0
        elif kill -0 "$pid" 2>/dev/null; then
            ok=2
        fi
    fi
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    PREFLIGHT_OUTPUT="$(head -c 4000 "$dir/out.log")"
    rm -rf "$dir"
    return $ok
}

# Version strings: the same charset the Dockerfile accepts for the manifest
# version.
VERSION_CHARS='A-Za-z0-9._+-'

backup_name_ok() {
    [[ "$1" =~ ^[A-Za-z0-9._+-]+-[0-9]{8}T[0-9]{6}Z$ ]]
}

# True if $1 is a directory this script created: <version>-<UTC timestamp>,
# not a symlink, with a regular backup-info.json of kind "package-upgrade".
# Everything else in $BACKUP_ROOT (e.g. the backend's
# <ts>-before-wallet-change or mnemonic-archive-<ts>) is never pruned.
is_upgrade_backup() {
    local path="$BACKUP_ROOT/$1"
    backup_name_ok "$1" && [ -d "$path" ] && [ ! -L "$path" ] &&
        [ -f "$path/backup-info.json" ] && [ ! -L "$path/backup-info.json" ] &&
        grep -q '"kind": "package-upgrade"' "$path/backup-info.json"
}

# True if the upgrade backup $1 is marked "keepForever": true (the first
# backup, taken from the pre-1.0 install). Such backups are never pruned and
# do not count toward $BACKUP_KEEP.
is_keep_forever() {
    grep -q '"keepForever": true' "$BACKUP_ROOT/$1/backup-info.json" 2>/dev/null
}

# prune_backups <just_created_name>
# Keeps every keepForever backup, the backup just created (whatever its
# timestamp, so a clock that is behind can't remove it), and the newest other
# upgrade backups up to $BACKUP_KEEP in total (keepForever not counted);
# removes older upgrade backups.
prune_backups() {
    local keep_name="$1" names=() name path
    for path in "$BACKUP_ROOT"/*; do
        name="${path##*/}"
        [ "$name" = "$keep_name" ] && continue
        is_upgrade_backup "$name" || continue
        is_keep_forever "$name" && continue
        names+=("$name")
    done
    local keep_others=$((BACKUP_KEEP - 1))
    is_keep_forever "$keep_name" && keep_others=$BACKUP_KEEP
    [ "${#names[@]}" -le "$keep_others" ] && return 0
    # Sort by the timestamp suffix, newest first.
    local sorted
    sorted="$(for name in "${names[@]}"; do echo "${name##*-} $name"; done | sort -r | awk '{print $2}')"
    local n=0
    for name in $sorted; do
        n=$((n + 1))
        if [ "$n" -gt "$keep_others" ]; then
            log "Removing old backup $name"
            rm -rf -- "${BACKUP_ROOT:?}/$name"
        fi
    done
}

# True if any package-upgrade backup exists.
has_upgrade_backup() {
    local path
    for path in "$BACKUP_ROOT"/*; do
        is_upgrade_backup "${path##*/}" && return 0
    done
    return 1
}

# Removes .partial-* directories (interrupted backups, e.g. power loss during
# the copy) older than 1 hour. Never follows symlinks.
clean_stale_partials() {
    [ -d "$BACKUP_ROOT" ] || return 0
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +60 -print0 2>/dev/null |
        while IFS= read -r -d '' path; do
            log "Removing interrupted backup ${path##*/}"
            rm -rf -- "$path"
        done
}

# Fingerprint of the node identity files (wallet, password, address). Stored
# next to the version marker; a change while the version is the same (e.g. a
# rollback to 0.0.106, a new wallet there, then this version again) makes a
# new backup.
data_fingerprint() {
    local f
    for f in wallet password address; do
        if [ -f "$DATA_DIR/$f" ]; then
            printf '%s %s\n' "$f" "$(sha256sum <"$DATA_DIR/$f" | cut -d' ' -f1)"
        else
            printf '%s none\n' "$f"
        fi
    done | sha256sum | cut -d' ' -f1
}

# Backs up the wallet, keys and settings when the package version changed,
# or when the version is the same but the wallet/password/address changed
# since the last start. Sets BACKUP_PATH (empty when no backup was needed).
# Returns 1 on any failure; the markers are then not written.
backup_if_needed() {
    BACKUP_PATH=""
    clean_stale_partials

    local old="" old_fp="" fp reason
    [ -f "$VERSION_MARKER" ] && old="$(head -n1 "$VERSION_MARKER" | tr -cd "$VERSION_CHARS")"
    [ -f "$FINGERPRINT_FILE" ] && old_fp="$(head -n1 "$FINGERPRINT_FILE" | tr -cd '0-9a-f')"
    fp="$(data_fingerprint)" || return 1
    if [ -n "$old" ] && [ "$old" = "$PACKAGE_VERSION" ]; then
        if [ "$old_fp" = "$fp" ]; then
            log "Package version $PACKAGE_VERSION and wallet unchanged, no backup needed"
            return 0
        fi
        reason="wallet-changed"
    else
        reason="version-changed"
    fi
    local label="${old:-legacy}"

    local data_items=() settings_items=() item
    for item in "${BACKUP_DATA_ITEMS[@]}"; do
        [ -e "$DATA_DIR/$item" ] && data_items+=("$item")
    done
    for item in "${BACKUP_SETTINGS_ITEMS[@]}"; do
        [ -f "$item" ] && settings_items+=("$item")
    done

    if [ "${#data_items[@]}" -eq 0 ] && [ "${#settings_items[@]}" -eq 0 ]; then
        log "Nothing to back up (new install)"
    else
        local ts
        ts="${AVADO_NOW:-$(date -u +%Y%m%dT%H%M%SZ)}"
        local name="${label}-${ts}"
        local dest="$BACKUP_ROOT/$name"
        local tmp="$BACKUP_ROOT/.partial-$name"
        if [ "$reason" = "wallet-changed" ]; then
            log "Backed up the wallet after it changed (e.g. new validator keys) to $dest"
        else
            log "Package version changed (${old:-none} -> $PACKAGE_VERSION): backing up to $dest"
        fi

        mkdir -p "$BACKUP_ROOT" && chmod 700 "$BACKUP_ROOT" || return 1
        if [ -e "$dest" ]; then
            log "ERROR: backup $dest already exists"
            return 1
        fi
        rm -rf -- "$tmp"
        mkdir -m 700 "$tmp" || return 1

        for item in "${data_items[@]}"; do
            if ! cp -a -- "$DATA_DIR/$item" "$tmp/$item" || ! diff -r -q -- "$DATA_DIR/$item" "$tmp/$item" >/dev/null; then
                log "ERROR: could not back up $item"
                rm -rf -- "$tmp"
                return 1
            fi
        done
        if [ "${#settings_items[@]}" -gt 0 ]; then
            mkdir -p "$tmp/settings" || { rm -rf -- "$tmp"; return 1; }
            for item in "${settings_items[@]}"; do
                if ! cp -a -- "$item" "$tmp/settings/" || ! cmp -s -- "$item" "$tmp/settings/$(basename "$item")"; then
                    log "ERROR: could not back up $item"
                    rm -rf -- "$tmp"
                    return 1
                fi
            done
        fi
        # The first upgrade backup (from a pre-1.0 install, or the first one
        # made at all) is kept forever.
        local keep_forever=false
        if ! has_upgrade_backup ||
            { [ "$reason" = "version-changed" ] && { [ -z "$old" ] || [ "${old%%.*}" = "0" ]; }; }; then
            keep_forever=true
        fi
        if ! {
            printf '{\n  "kind": "package-upgrade",\n  "keepForever": %s,\n  "reason": "%s",\n  "fromVersion": "%s",\n  "toVersion": "%s",\n  "createdAt": "%s",\n  "items": [' \
                "$keep_forever" "$reason" "$(json_escape "${old:-}")" "$(json_escape "$PACKAGE_VERSION")" "$ts"
            local first=1
            for item in "${data_items[@]}"; do
                [ $first -eq 1 ] && first=0 || printf ','
                printf '"%s"' "$(json_escape "$item")"
            done
            for item in "${settings_items[@]}"; do
                [ $first -eq 1 ] && first=0 || printf ','
                printf '"settings/%s"' "$(json_escape "$(basename "$item")")"
            done
            printf ']\n}\n'
        } >"$tmp/backup-info.json"; then
            rm -rf -- "$tmp"
            return 1
        fi
        sync
        mv -- "$tmp" "$dest" || { rm -rf -- "$tmp"; return 1; }
        BACKUP_PATH="$dest"
        prune_backups "$name"
    fi

    # Only now record the new version and fingerprint.
    printf '%s\n' "$PACKAGE_VERSION" >"${VERSION_MARKER}.tmp" && mv -f "${VERSION_MARKER}.tmp" "$VERSION_MARKER" || return 1
    printf '%s\n' "$fp" >"${FINGERPRINT_FILE}.tmp" && mv -f "${FINGERPRINT_FILE}.tmp" "$FINGERPRINT_FILE" || return 1
    return 0
}
