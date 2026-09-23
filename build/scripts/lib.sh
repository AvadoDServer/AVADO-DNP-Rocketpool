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
TEMPLATE_FILE="${TEMPLATE_FILE:-${RP_DIR}/user-settings.template}"
SETTINGS_FILE="${SETTINGS_FILE:-${RP_DIR}/user-settings.yml}"
RP_BIN="${RP_BIN:-/usr/local/bin/rocketpoold}"

# Exit code for "configuration problem, do not restart" (sysexits EX_CONFIG).
# supervisord lists it in exitcodes, so it leaves the daemon stopped.
EX_CONFIG=78

# Items in the data dir that the upgrade backup copies (if present).
BACKUP_DATA_ITEMS=(wallet password validators mnemonic transactions.json)
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
# States: starting | unsupported_config | backup_failed | config_error
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
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    PREFLIGHT_OUTPUT="$(head -c 4000 "$dir/out.log")"
    rm -rf "$dir"
    return $ok
}

backup_name_ok() {
    [[ "$1" =~ ^[A-Za-z0-9._-]+-[0-9]{8}T[0-9]{6}Z$ ]]
}

# Removes backups beyond the newest $BACKUP_KEEP. Only touches directories in
# $BACKUP_ROOT whose name matches <label>-<UTC timestamp>.
prune_backups() {
    local names=() name path
    for path in "$BACKUP_ROOT"/*; do
        name="${path##*/}"
        # Never follow or delete anything that is not our own backup dir.
        backup_name_ok "$name" && [ -d "$path" ] && [ ! -L "$path" ] && names+=("$name")
    done
    [ "${#names[@]}" -le "$BACKUP_KEEP" ] && return 0
    # Sort by the timestamp suffix, newest first.
    local sorted
    sorted="$(for name in "${names[@]}"; do echo "${name##*-} $name"; done | sort -r | awk '{print $2}')"
    local n=0
    for name in $sorted; do
        n=$((n + 1))
        if [ "$n" -gt "$BACKUP_KEEP" ]; then
            log "Removing old backup $name"
            rm -rf -- "${BACKUP_ROOT:?}/$name"
        fi
    done
}

# Backs up the wallet, keys and settings when the package version changed.
# Sets BACKUP_PATH (empty when no backup was needed). Returns 1 on any
# failure; the version marker is then not written.
backup_if_needed() {
    BACKUP_PATH=""
    local old=""
    [ -f "$VERSION_MARKER" ] && old="$(head -n1 "$VERSION_MARKER" | tr -cd 'A-Za-z0-9._-')"
    if [ -n "$old" ] && [ "$old" = "$PACKAGE_VERSION" ]; then
        log "Package version $PACKAGE_VERSION unchanged, no backup needed"
        return 0
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
        log "Package version changed (${old:-none} -> $PACKAGE_VERSION): backing up to $dest"

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
        if ! {
            printf '{\n  "fromVersion": "%s",\n  "toVersion": "%s",\n  "createdAt": "%s",\n  "items": [' \
                "$(json_escape "${old:-}")" "$(json_escape "$PACKAGE_VERSION")" "$ts"
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
        prune_backups
    fi

    # Only now record the new version.
    printf '%s\n' "$PACKAGE_VERSION" >"${VERSION_MARKER}.tmp" && mv -f "${VERSION_MARKER}.tmp" "$VERSION_MARKER" || return 1
    return 0
}
