#!/bin/bash
# Tests for build/start-node.sh, build/scripts/lib.sh and build/user-settings.template.
# Needs bash >= 4.4, envsubst (gettext-base), diff/cmp. Run it with
# build/tests/run.sh, which uses the same Debian base as the runtime image.
# No real rocketpoold is needed: a stub stands in for it.

set -u

BUILD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
CURRENT=""

t() { CURRENT="$1"; }
ok() { PASS=$((PASS + 1)); }
fail() {
    FAIL=$((FAIL + 1))
    echo "FAIL [$CURRENT]: $*"
}
assert_eq() { [ "$1" = "$2" ] && ok || fail "expected '$2', got '$1' ${3:-}"; }
assert_contains() { grep -qF -- "$2" "$1" && ok || fail "'$1' does not contain '$2'"; }
assert_not_contains() { grep -qF -- "$2" "$1" && fail "'$1' contains '$2'" || ok; }
assert_file() { [ -e "$1" ] && ok || fail "missing $1"; }
assert_no_file() { [ -e "$1" ] && fail "unexpected $1" || ok; }

# Stub rocketpoold: prints the version, and for "node" logs its arguments.
# With a settings file whose apiPort is "0" (the preflight) it prints the
# line the real daemon prints after loading the config, unless
# STUB_FAIL_CONFIG is set.
STUB="$WORK/rocketpoold"
cat >"$STUB" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "rocketpool version 1.24.2"; exit 0; fi
settings="$2"
if grep -q 'apiPort: "0"' "$settings"; then
    # Slow mode: while the counter file holds N>0, hang without output
    # (a preflight timeout) and decrement it.
    if [ -n "${STUB_SLOW_FILE:-}" ] && [ "$(cat "$STUB_SLOW_FILE" 2>/dev/null || echo 0)" -gt 0 ]; then
        echo $(( $(cat "$STUB_SLOW_FILE") - 1 )) >"$STUB_SLOW_FILE"
        sleep 30
        exit 0
    fi
    if [ -n "${STUB_FAIL_CONFIG:-}" ]; then
        echo "could not deserialize settings file: stub failure"
        exit 1
    fi
    echo "Starting node daemon in Native Mode."
    sleep 30
    exit 0
fi
echo "STUB-DAEMON $*" >>"${STUB_CALLS:?}"
exit 0
EOF
chmod +x "$STUB"

# Fresh sandbox: data dir in the 0.0.106 layout.
new_sandbox() {
    SB="$WORK/sb-$1"
    rm -rf "$SB"
    mkdir -p "$SB/srv" "$SB/data/validators/teku/keys" "$SB/data/validators/teku/passwords" "$SB/data/rewards-trees"
    cp "$BUILD_DIR/user-settings.template" "$SB/srv/"
    echo "0.0.107-test" >"$SB/srv/package-version"
    printf '{"crypto":"fixture-wallet"}' >"$SB/data/wallet"
    printf 'fixture-password' >"$SB/data/password"
    chmod 600 "$SB/data/wallet" "$SB/data/password"
    printf '{"pubkey":"aa"}' >"$SB/data/validators/teku/keys/0xaa.json"
    printf 'pw' >"$SB/data/validators/teku/passwords/0xaa.txt"
    printf 'FEE_RECIPIENT=0x0' >"$SB/data/validators/rp-fee-recipient-env.txt"
    printf 'word1 word2' >"$SB/data/mnemonic"
    mkdir -p "$SB/data/custom-keys" "$SB/data/custom-key-passwords"
    printf '{"k":1}' >"$SB/data/custom-keys/keystore-1.json"
    printf 'kp' >"$SB/data/custom-key-passwords/keystore-1.txt"
    printf '[]' >"$SB/data/transactions.json"
    printf '{}' >"$SB/data/rewards-trees/rp-rewards-mainnet-1.json"
    printf 'old: settings\n' >"$SB/srv/user-settings.yml"

    export RP_DIR="$SB/srv"
    export DATA_DIR="$SB/data"
    export BACKUP_ROOT="$SB/backups"
    export STATUS_FILE="$SB/status.json"
    export VERSION_MARKER="$SB/data/.avado-package-version"
    export FINGERPRINT_FILE="$SB/data/.avado-backup-fingerprint"
    export TEMPLATE_FILE="$SB/srv/user-settings.template"
    export SETTINGS_FILE="$SB/srv/user-settings.yml"
    export RP_BIN="$STUB"
    export STUB_CALLS="$SB/calls"
    export LIB_FILE="$BUILD_DIR/scripts/lib.sh"
    export DAEMON_LOG=""
    export LAST_START_FILE="$SB/last-start"
    export STARTUP_ERROR_FILE="$SB/startup-error.txt"
    export PREFLIGHT_TIMEOUT=10
    export NETWORK=mainnet EXECUTIONCLIENT=geth CONSENSUSCLIENT=teku
    unset PACKAGE_VERSION AVADO_NOW STUB_FAIL_CONFIG STUB_SLOW_FILE PREFLIGHT_BACKOFF_START
}

tree_sum() {
    # Contents, modes, sizes and mtimes of everything except the version
    # marker (which the backup writes on purpose).
    (cd "$1" && find . -mindepth 1 \( -path ./.avado-package-version -o -path ./.avado-backup-fingerprint \) -prune -o -type f -print | LC_ALL=C sort | xargs sha256sum
        find . -mindepth 1 \( -path ./.avado-package-version -o -path ./.avado-backup-fingerprint \) -prune -o -print | LC_ALL=C sort | xargs stat -c '%n %a %s %Y')
}

run_start() {
    rm -f "$SB/last-start"
    bash "$BUILD_DIR/start-node.sh" >"$SB/out.log" 2>&1
    echo $?
}

lib() {
    # Runs lib.sh functions in a subshell with the sandbox env.
    bash -c ". '$BUILD_DIR/scripts/lib.sh'; $1"
}

########## Template rendering

t "render: all placeholders substituted, values as specified"
new_sandbox render
lib 'SMARTNODE_VERSION=1.24.2; resolve_client_urls && render_settings "$SETTINGS_FILE" "/rocketpool/data" "$EC_HTTP_URL" "$CC_HTTP_URL" 8280'
S="$SETTINGS_FILE"
assert_not_contains "$S" '${'
assert_contains "$S" '  version: v1.24.2'
assert_contains "$S" '  isNative: "true"'
assert_contains "$S" '  network: mainnet'
assert_contains "$S" '  dataPath: /rocketpool/data'
assert_contains "$S" '  ecHttpUrl: http://ethchain-geth.my.ava.do:8545'
assert_contains "$S" '  ccHttpUrl: http://teku.my.ava.do:5051'
assert_contains "$S" '  consensusClient: teku'
assert_contains "$S" '  apiPort: "8280"'
assert_contains "$S" '  openApiPort: localhost'
assert_contains "$S" '  manualMaxFee: "0"'
assert_contains "$S" '  priorityFee: "1"'
assert_contains "$S" '  minipoolStakeGasThreshold: "20"'
assert_contains "$S" "  validatorRestartCommand: $RP_DIR/signal-reconcile.sh"
assert_contains "$S" "  validatorStopCommand: $RP_DIR/signal-reconcile.sh"
assert_contains "$S" '  enableMetrics: "false"'

t "render: YAML is a map of string maps (the loader's type)"
# Every non-comment line is "section:" or "  key: value".
bad="$(grep -vE '^(#.*|  #.*|[a-z]+:|  [A-Za-z0-9]+: .+|)$' "$S" || true)"
assert_eq "$bad" "" "(unexpected lines)"

t "render: root.version follows the binary"
lib 'SMARTNODE_VERSION=$(smartnode_version); resolve_client_urls && render_settings "$SETTINGS_FILE" /x "$EC_HTTP_URL" "$CC_HTTP_URL" 8280'
assert_contains "$S" '  version: v1.24.2'

########## Client URLs

t "urls: every EL/CL combination"
for ec in geth nethermind reth; do
    for cc in teku nimbus lighthouse prysm; do
        out="$(EXECUTIONCLIENT=$ec CONSENSUSCLIENT=$cc lib 'resolve_client_urls && echo "$EC_HTTP_URL|$EC_WS_URL|$CC_HTTP_URL"')"
        case "$ec" in
        geth) exp_ec="http://ethchain-geth.my.ava.do:8545|ws://ethchain-geth.my.ava.do:8546" ;;
        nethermind) exp_ec="http://avado-dnp-nethermind.my.ava.do:8545|ws://avado-dnp-nethermind.my.ava.do:8545" ;;
        reth) exp_ec="http://reth-mainnet.my.ava.do:8545|ws://reth-mainnet.my.ava.do:8546" ;;
        esac
        case "$cc" in
        teku) exp_cc="http://teku.my.ava.do:5051" ;;
        nimbus) exp_cc="http://nimbus.my.ava.do:5052" ;;
        lighthouse) exp_cc="http://lighthouse.my.ava.do:5052" ;;
        prysm) exp_cc="http://prysm-beacon-chain-mainnet.my.ava.do:3500" ;;
        esac
        assert_eq "$out" "$exp_ec|$exp_cc" "($ec/$cc)"
    done
done

t "urls: unsupported values are rejected"
for combo in "holesky geth teku" "prater geth teku" "testnet geth teku" " geth teku" "mainnet erigon teku" "mainnet geth lodestar" "mainnet geth "; do
    set -- $combo
    out="$(NETWORK="${1:-}" EXECUTIONCLIENT="${2:-}" CONSENSUSCLIENT="${3:-}" lib 'resolve_client_urls && echo OK || echo "ERR:$ERROR"')"
    case "$out" in ERR:*) ok ;; *) fail "accepted '$combo'" ;; esac
done

########## Backup

t "backup: first start of a new version backs up everything, originals untouched"
new_sandbox backup1
before="$(tree_sum "$DATA_DIR")"
PACKAGE_VERSION=0.0.107-test AVADO_NOW=20260923T100000Z lib 'backup_if_needed && echo "RESULT=$BACKUP_PATH"' | sed -n 's/^RESULT=//p' >"$SB/res"
B="$BACKUP_ROOT/legacy-20260923T100000Z"
assert_eq "$(cat "$SB/res")" "$B"
for f in wallet password mnemonic transactions.json custom-keys/keystore-1.json custom-key-passwords/keystore-1.txt validators/teku/keys/0xaa.json validators/teku/passwords/0xaa.txt validators/rp-fee-recipient-env.txt; do
    cmp -s "$DATA_DIR/$f" "$B/$f" && ok || fail "backup of $f differs"
done
assert_eq "$(stat -c %a "$B/wallet")" "600" "(wallet mode kept)"
assert_eq "$(stat -c %a "$B")" "700" "(backup dir private)"
assert_file "$B/settings/user-settings.yml"
assert_file "$B/backup-info.json"
assert_contains "$B/backup-info.json" '"toVersion": "0.0.107-test"'
assert_contains "$B/backup-info.json" '"kind": "package-upgrade"'
assert_file "$FINGERPRINT_FILE"
assert_no_file "$B/rewards-trees"
assert_eq "$(cat "$VERSION_MARKER")" "0.0.107-test"
assert_eq "$(tree_sum "$DATA_DIR")" "$before" "(data dir modified)"

t "backup: same version again does nothing"
PACKAGE_VERSION=0.0.107-test AVADO_NOW=20260923T110000Z lib 'backup_if_needed'
assert_eq "$(ls "$BACKUP_ROOT" | wc -l | tr -d ' ')" "1"

t "backup: keeps the newest 3, labelled with the old version"
for i in 1 2 3 4; do
    PACKAGE_VERSION="1.0.$i" AVADO_NOW="2026100${i}T120000Z" lib 'backup_if_needed'
done
names="$(ls "$BACKUP_ROOT" | LC_ALL=C sort | tr '\n' ' ')"
# legacy-* (from a pre-1.0 install) and 0.0.107-test-* (previous version < 1.0.0)
# are keepForever; of the rest the newest 3 are kept.
assert_eq "$names" "0.0.107-test-20261001T120000Z 1.0.1-20261002T120000Z 1.0.2-20261003T120000Z 1.0.3-20261004T120000Z legacy-20260923T100000Z "
assert_eq "$(cat "$VERSION_MARKER")" "1.0.4"
assert_eq "$(tree_sum "$DATA_DIR")" "$before" "(data dir modified)"

t "backup: pruning ignores foreign directories"
# The backend creates "<name>-before-wallet-change" backups here; pruning must
# never touch them, even when they are older than everything else.
mkdir -p "$BACKUP_ROOT/keep-me" "$BACKUP_ROOT/manual copy" \
    "$BACKUP_ROOT/1.0.0-20200101T000000Z-before-wallet-change" "$BACKUP_ROOT/20200101T000000Z-before-wallet-change"
touch "$BACKUP_ROOT/1.0.0-20200101T000000Z"
mkdir -p "$SB/elsewhere" && touch "$SB/elsewhere/precious"
ln -s "$SB/elsewhere" "$BACKUP_ROOT/0.9.0-20190101T000000Z"
PACKAGE_VERSION="1.0.5" AVADO_NOW="20261005T120000Z" lib 'backup_if_needed'
assert_file "$BACKUP_ROOT/keep-me"
assert_file "$BACKUP_ROOT/manual copy"
assert_file "$BACKUP_ROOT/1.0.0-20200101T000000Z-before-wallet-change"
assert_file "$BACKUP_ROOT/20200101T000000Z-before-wallet-change"
assert_file "$BACKUP_ROOT/1.0.0-20200101T000000Z"
assert_file "$BACKUP_ROOT/0.9.0-20190101T000000Z"
assert_file "$SB/elsewhere/precious"
assert_file "$BACKUP_ROOT/1.0.4-20261005T120000Z"
assert_file "$BACKUP_ROOT/1.0.2-20261003T120000Z"
assert_no_file "$BACKUP_ROOT/1.0.1-20261002T120000Z"


t "backup (I2): only our own package-upgrade backups are pruned"
new_sandbox kinds
mkdir -p "$BACKUP_ROOT"
for d in mnemonic-archive-20200101T000000Z 20200101T000000Z-before-wallet-change 0.0.50-20200101T000000Z; do
    mkdir -p "$BACKUP_ROOT/$d" && printf 'keep' >"$BACKUP_ROOT/$d/content"
done
# Matches the name pattern and has an info file, but not our kind:
printf '{"kind": "manual"}' >"$BACKUP_ROOT/0.0.50-20200101T000000Z/backup-info.json"
for i in 1 2 3 4 5; do
    PACKAGE_VERSION="2.0.$i" AVADO_NOW="2026110${i}T120000Z" lib 'backup_if_needed' >/dev/null
done
assert_file "$BACKUP_ROOT/mnemonic-archive-20200101T000000Z/content"
assert_file "$BACKUP_ROOT/20200101T000000Z-before-wallet-change/content"
assert_file "$BACKUP_ROOT/0.0.50-20200101T000000Z/content"
upgrades="$(for d in "$BACKUP_ROOT"/*; do [ -f "$d/backup-info.json" ] && grep -q '"kind": "package-upgrade"' "$d/backup-info.json" && basename "$d"; done | LC_ALL=C sort | tr '\n' ' ')"
assert_eq "$upgrades" "2.0.2-20261103T120000Z 2.0.3-20261104T120000Z 2.0.4-20261105T120000Z legacy-20261101T120000Z "

t "backup (I1): the backup just made survives pruning when the clock is behind"
new_sandbox skew
for i in 6 7 8 9; do
    PACKAGE_VERSION="1.0.$i" AVADO_NOW="2027010${i}T000000Z" lib 'backup_if_needed' >/dev/null
done
PACKAGE_VERSION="1.1.0" AVADO_NOW="20260101T000000Z" lib 'backup_if_needed && echo "RESULT=$BACKUP_PATH"' | sed -n 's/^RESULT=//p' >"$SB/res"
assert_eq "$(cat "$SB/res")" "$BACKUP_ROOT/1.0.9-20260101T000000Z"
assert_file "$BACKUP_ROOT/1.0.9-20260101T000000Z/wallet"
assert_file "$BACKUP_ROOT/legacy-20270106T000000Z" "(keepForever)"
assert_file "$BACKUP_ROOT/1.0.8-20270109T000000Z"
assert_file "$BACKUP_ROOT/1.0.7-20270108T000000Z"
assert_no_file "$BACKUP_ROOT/1.0.6-20270107T000000Z"
assert_eq "$(ls "$BACKUP_ROOT" | wc -l | tr -d ' ')" "4"

t "backup (M1): same version but a changed wallet (rollback, new wallet, reinstall) makes a new backup"
new_sandbox rollback
PACKAGE_VERSION=1.0.0 AVADO_NOW=20261201T000000Z lib 'backup_if_needed' >/dev/null
PACKAGE_VERSION=1.0.0 AVADO_NOW=20261202T000000Z lib 'backup_if_needed' >/dev/null
assert_eq "$(ls "$BACKUP_ROOT" | wc -l | tr -d ' ')" "1" "(unchanged: no new backup)"
# 0.0.106 runs in between and the owner restores a different wallet:
printf '{"crypto":"other-wallet"}' >"$DATA_DIR/wallet"
PACKAGE_VERSION=1.0.0 AVADO_NOW=20261203T000000Z lib 'backup_if_needed' >/dev/null
assert_file "$BACKUP_ROOT/1.0.0-20261203T000000Z/wallet"
assert_eq "$(cat "$BACKUP_ROOT/1.0.0-20261203T000000Z/wallet")" '{"crypto":"other-wallet"}'
assert_contains "$BACKUP_ROOT/1.0.0-20261203T000000Z/backup-info.json" '"reason": "wallet-changed"'
PACKAGE_VERSION=1.0.0 AVADO_NOW=20261204T000000Z lib 'backup_if_needed' >/dev/null
assert_eq "$(ls "$BACKUP_ROOT" | wc -l | tr -d ' ')" "2" "(stable again)"
# A new address file (masquerade) also counts:
printf '0x01' >"$DATA_DIR/address"
PACKAGE_VERSION=1.0.0 AVADO_NOW=20261205T000000Z lib 'backup_if_needed' >/dev/null
assert_file "$BACKUP_ROOT/1.0.0-20261205T000000Z/address"

t "backup (M3): a '+' in the version does not back up on every start"
new_sandbox plus
PACKAGE_VERSION="0.0.111+b" AVADO_NOW=20261201T000000Z lib 'backup_if_needed' >/dev/null
PACKAGE_VERSION="0.0.111+b" AVADO_NOW=20261202T000000Z lib 'backup_if_needed' >/dev/null
assert_eq "$(ls "$BACKUP_ROOT" | wc -l | tr -d ' ')" "1"
assert_eq "$(cat "$VERSION_MARKER")" "0.0.111+b"
PACKAGE_VERSION="0.0.112" AVADO_NOW=20261203T000000Z lib 'backup_if_needed' >/dev/null
assert_file "$BACKUP_ROOT/0.0.111+b-20261203T000000Z/backup-info.json"

t "backup (M4): interrupted .partial-* dirs older than 1h are removed, recent ones kept"
new_sandbox partial
mkdir -p "$BACKUP_ROOT/.partial-1.0.0-20260101T000000Z" "$BACKUP_ROOT/.partial-1.0.0-20260102T000000Z" "$SB/outside"
touch "$SB/outside/precious"
ln -s "$SB/outside" "$BACKUP_ROOT/.partial-link"
touch -d '2 hours ago' "$BACKUP_ROOT/.partial-1.0.0-20260101T000000Z" "$BACKUP_ROOT/.partial-link"
PACKAGE_VERSION=1.0.0 lib 'backup_if_needed' >/dev/null
assert_no_file "$BACKUP_ROOT/.partial-1.0.0-20260101T000000Z"
assert_file "$BACKUP_ROOT/.partial-1.0.0-20260102T000000Z"
assert_file "$SB/outside/precious"


t "backup: the first backup from the pre-1.0 install is kept forever"
new_sandbox forever
echo "0.0.106" >"$VERSION_MARKER"
PACKAGE_VERSION=1.0.0 AVADO_NOW=20261201T000000Z lib 'backup_if_needed' >/dev/null
F="$BACKUP_ROOT/0.0.106-20261201T000000Z"
assert_contains "$F/backup-info.json" '"keepForever": true'
# Six wallet changes under 1.0.0 (fingerprint-triggered backups), then an upgrade.
for i in 2 3 4 5 6 7; do
    printf '{"crypto":"wallet-%s"}' "$i" >"$DATA_DIR/wallet"
    PACKAGE_VERSION=1.0.0 AVADO_NOW="2026120${i}T000000Z" lib 'backup_if_needed' >/dev/null
done
PACKAGE_VERSION=1.0.1 AVADO_NOW=20261208T000000Z lib 'backup_if_needed' >/dev/null
assert_file "$F/wallet"
assert_eq "$(cat "$F/wallet")" '{"crypto":"fixture-wallet"}'
others="$(ls "$BACKUP_ROOT" | grep -v '^0.0.106-' | LC_ALL=C sort | tr '\n' ' ')"
assert_eq "$others" "1.0.0-20261206T000000Z 1.0.0-20261207T000000Z 1.0.0-20261208T000000Z "
assert_contains "$BACKUP_ROOT/1.0.0-20261208T000000Z/backup-info.json" '"keepForever": false'
assert_contains "$BACKUP_ROOT/1.0.0-20261207T000000Z/backup-info.json" '"keepForever": false'

t "backup: keepForever is also set when no other upgrade backup exists (1.x -> 1.y first run)"
new_sandbox forever2
echo "1.0.0" >"$VERSION_MARKER"
PACKAGE_VERSION=1.0.1 AVADO_NOW=20261201T000000Z lib 'backup_if_needed' >/dev/null
assert_contains "$BACKUP_ROOT/1.0.0-20261201T000000Z/backup-info.json" '"keepForever": true'

t "backup: new install with an empty data dir writes only the marker"
new_sandbox fresh
rm -rf "$DATA_DIR"/* "$SETTINGS_FILE"
PACKAGE_VERSION=1.0.0 lib 'backup_if_needed' && ok || fail "returned failure"
assert_no_file "$BACKUP_ROOT"
assert_eq "$(cat "$VERSION_MARKER")" "1.0.0"

t "backup: copy failure refuses to continue, leaves no partial backup, no marker"
new_sandbox copyfail
before="$(tree_sum "$DATA_DIR")"
mkdir -p "$SB/shim"
cat >"$SB/shim/cp" <<'EOF'
#!/bin/bash
for a in "$@"; do case "$a" in */validators) echo "cp: No space left on device" >&2; exit 1 ;; esac; done
exec /bin/cp "$@"
EOF
chmod +x "$SB/shim/cp"
PATH="$SB/shim:$PATH" PACKAGE_VERSION=1.0.0 lib 'backup_if_needed' && fail "backup reported success" || ok
assert_no_file "$VERSION_MARKER"
assert_eq "$(ls -A "$BACKUP_ROOT" | wc -l | tr -d ' ')" "0" "(partial backup left)"
assert_eq "$(tree_sum "$DATA_DIR")" "$before" "(data dir modified)"

t "backup: verification catches a bad copy"
new_sandbox badcopy
cat >"$SB/shim-cp" <<'EOF'
#!/bin/bash
/bin/cp "$@" || exit 1
last="${@: -1}"
case "$last" in */wallet) printf 'corrupt' >"$last" ;; esac
exit 0
EOF
mkdir -p "$SB/shim" && mv "$SB/shim-cp" "$SB/shim/cp" && chmod +x "$SB/shim/cp"
PATH="$SB/shim:$PATH" PACKAGE_VERSION=1.0.0 lib 'backup_if_needed' && fail "backup reported success" || ok
assert_no_file "$VERSION_MARKER"
assert_eq "$(cat "$DATA_DIR/wallet")" '{"crypto":"fixture-wallet"}'

########## Found wallets (no wallet in the data dir)

t "found wallets: one line per wallet file elsewhere on the volume, never its contents"
new_sandbox found
rm -f "$DATA_DIR/wallet"
mkdir -p "$BACKUP_ROOT/legacy-20261006T200006Z" "$SB/old/.rocketpool/data" "$SB/a/b/c/d/e/f"
printf '{"crypto":"backup-wallet"}' >"$BACKUP_ROOT/legacy-20261006T200006Z/wallet"
printf '{"crypto":"old-wallet"}' >"$SB/old/.rocketpool/data/wallet"
printf '{"crypto":"too-deep"}' >"$SB/a/b/c/d/e/f/wallet"
lib 'log_found_wallets' >"$SB/found.log" && ok || fail "returned failure"
assert_contains "$SB/found.log" "[start-node] No wallet in $DATA_DIR. A wallet file exists at $BACKUP_ROOT/legacy-20261006T200006Z/wallet (the app offers to use it)."
assert_contains "$SB/found.log" "[start-node] No wallet in $DATA_DIR. A wallet file exists at $SB/old/.rocketpool/data/wallet (the app offers to use it)."
assert_eq "$(wc -l <"$SB/found.log" | tr -d ' ')" "2" "(depth 7 is not searched)"
assert_not_contains "$SB/found.log" "crypto"
assert_not_contains "$SB/found.log" "none found"

t "found wallets: none anywhere"
new_sandbox foundnone
rm -f "$DATA_DIR/wallet"
lib 'log_found_wallets' >"$SB/found.log" && ok || fail "returned failure"
assert_eq "$(cat "$SB/found.log")" "[start-node] No wallet in $DATA_DIR and none found elsewhere on the volume (new install, or restore with the recovery phrase)."

t "found wallets: the data dir's own wallet is never reported"
new_sandbox foundself
lib 'log_found_wallets' >"$SB/found.log"
assert_not_contains "$SB/found.log" "$DATA_DIR/wallet"
assert_contains "$SB/found.log" "none found elsewhere"

t "start: with no wallet in the data dir, the log says where one is; with one, nothing is said"
new_sandbox startfound
rm -f "$DATA_DIR/wallet"
mkdir -p "$SB/old"
printf '{"crypto":"old-wallet"}' >"$SB/old/wallet"
rc="$(run_start)"
assert_eq "$rc" "0"
assert_contains "$SB/out.log" "A wallet file exists at $SB/old/wallet (the app offers to use it)."
assert_not_contains "$SB/out.log" "old-wallet"
assert_no_file "$DATA_DIR/wallet"
new_sandbox startnofound
rc="$(run_start)"
assert_eq "$rc" "0"
assert_not_contains "$SB/out.log" "No wallet in"

########## start-node.sh end to end (stub daemon)

t "start: happy path backs up, renders, preflights, execs the daemon"
new_sandbox start
before="$(tree_sum "$DATA_DIR")"
rc="$(run_start)"
assert_eq "$rc" "0"
assert_contains "$SB/calls" "STUB-DAEMON --settings $SETTINGS_FILE node"
assert_contains "$SETTINGS_FILE" '  apiPort: "8280"'
assert_contains "$STATUS_FILE" '"state": "starting"'
assert_contains "$STATUS_FILE" '"ecWsUrl": "ws://ethchain-geth.my.ava.do:8546"'
assert_contains "$STATUS_FILE" '"backup": "'"$BACKUP_ROOT"'/legacy-'
assert_not_contains "$STATUS_FILE" "fixture-password"
assert_eq "$(ls "$BACKUP_ROOT" | wc -l | tr -d ' ')" "1"
assert_contains "$BACKUP_ROOT"/legacy-*/settings/user-settings.yml "old: settings"
assert_eq "$(cat "$VERSION_MARKER")" "0.0.107-test"
assert_eq "$(tree_sum "$DATA_DIR" | grep -v rewards-trees)" "$(echo "$before" | grep -v rewards-trees)" "(data dir modified)"

t "start: unsupported network keeps the daemon stopped"
new_sandbox badnet
export NETWORK=holesky
rc="$(run_start)"
assert_eq "$rc" "78"
assert_no_file "$SB/calls"
assert_contains "$STATUS_FILE" '"state": "unsupported_config"'
assert_contains "$STATUS_FILE" "Only mainnet is supported"
assert_contains "$STARTUP_ERROR_FILE" "Only mainnet is supported"
assert_eq "$(wc -l <"$STARTUP_ERROR_FILE" | tr -d ' ')" "1" "(one line)"
assert_no_file "$VERSION_MARKER"

t "start: backup failure keeps the daemon stopped"
new_sandbox startfail
printf 'not a dir' >"$SB/backups"
rc="$(run_start)"
assert_eq "$rc" "78"
assert_no_file "$SB/calls"
assert_contains "$STATUS_FILE" '"state": "backup_failed"'
assert_contains "$STARTUP_ERROR_FILE" "Backing up the wallet and keys"
assert_no_file "$VERSION_MARKER"
assert_contains "$SETTINGS_FILE" "old: settings"

t "start: config the daemon rejects keeps the daemon stopped"
new_sandbox preflight
export STUB_FAIL_CONFIG=1
rc="$(run_start)"
assert_eq "$rc" "78"
assert_no_file "$SB/calls"
assert_contains "$STATUS_FILE" '"state": "config_error"'
assert_contains "$STATUS_FILE" "stub failure"
assert_contains "$STARTUP_ERROR_FILE" "stub failure"
assert_eq "$(wc -l <"$STARTUP_ERROR_FILE" | tr -d ' ')" "1" "(one line)"


t "start: a clean start removes the previous startup error"
unset STUB_FAIL_CONFIG
rc="$(run_start)"
assert_eq "$rc" "0"
assert_no_file "$STARTUP_ERROR_FILE"
assert_contains "$SB/calls" "STUB-DAEMON"

t "start (M5): a preflight timeout retries with backoff instead of stopping the daemon"
new_sandbox slow
export STUB_SLOW_FILE="$SB/slow" PREFLIGHT_TIMEOUT=2 PREFLIGHT_BACKOFF_START=1
echo 2 >"$STUB_SLOW_FILE"
rc="$(run_start)"
assert_eq "$rc" "0"
assert_eq "$(grep -c 'timed out' "$SB/out.log")" "2" "(two retries)"
assert_contains "$SB/out.log" "Retrying in 1s"
assert_contains "$SB/out.log" "Retrying in 2s"
assert_contains "$SB/calls" "STUB-DAEMON --settings"
assert_no_file "$STARTUP_ERROR_FILE"
assert_contains "$STATUS_FILE" '"state": "starting"'

t "start (M5): while retrying, the startup-error file explains it"
new_sandbox slow2
export STUB_SLOW_FILE="$SB/slow" PREFLIGHT_TIMEOUT=1 PREFLIGHT_BACKOFF_START=5
echo 1 >"$STUB_SLOW_FILE"
rm -f "$SB/last-start"
bash "$BUILD_DIR/start-node.sh" >"$SB/out.log" 2>&1 &
sp=$!
for _ in $(seq 1 20); do [ -f "$STARTUP_ERROR_FILE" ] && break; sleep 0.5; done
assert_contains "$STARTUP_ERROR_FILE" "timed out"
assert_contains "$STATUS_FILE" '"state": "config_check_retry"'
assert_no_file "$SB/calls"
wait "$sp"
assert_eq "$?" "0"
assert_no_file "$STARTUP_ERROR_FILE"
assert_contains "$SB/calls" "STUB-DAEMON"

t "start: PACKAGE_VERSION from the environment wins over the file"
new_sandbox envversion
PACKAGE_VERSION=1.0.0 run_start >/dev/null
assert_eq "$(cat "$VERSION_MARKER")" "1.0.0"
assert_contains "$STATUS_FILE" '"packageVersion": "1.0.0"'

t "start: daemon output is also written to the log file"
new_sandbox logfile
export NETWORK=holesky DAEMON_LOG="$SB/log/daemon.log"
run_start >/dev/null
sleep 1
assert_contains "$SB/log/daemon.log" "Only mainnet is supported"
assert_contains "$SB/out.log" "Only mainnet is supported"

t "signal-reconcile.sh touches /tmp/reconcile-now and exits 0"
rm -f /tmp/reconcile-now
sh "$BUILD_DIR/signal-reconcile.sh"
assert_eq "$?" "0"
assert_file /tmp/reconcile-now
rm -f /tmp/reconcile-now

t "log-tee: copies to stdout and file, rotates"
new_sandbox logtee
seq 1 1000 | bash "$BUILD_DIR/scripts/log-tee.sh" "$SB/l.log" 1000 >"$SB/l.out"
assert_eq "$(wc -l <"$SB/l.out" | tr -d ' ')" "1000"
assert_file "$SB/l.log.1"
assert_eq "$(tail -n1 "$SB/l.log")" "1000"

t "log-tee: survives SIGTERM and exits at EOF"
coproc LT { exec bash "$BUILD_DIR/scripts/log-tee.sh" "$SB/t.log" >/dev/null; }
lt_pid=$LT_PID
echo before >&"${LT[1]}"
sleep 0.5
kill -TERM "$lt_pid" 2>/dev/null
sleep 0.5
kill -0 "$lt_pid" 2>/dev/null && ok || fail "log-tee died on SIGTERM"
echo after >&"${LT[1]}"
lt_in="${LT[1]}"
eval "exec ${lt_in}>&-"
wait "$lt_pid" 2>/dev/null
assert_eq "$(tr '\n' ' ' <"$SB/t.log")" "before after "

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
