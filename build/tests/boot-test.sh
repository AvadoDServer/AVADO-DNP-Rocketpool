#!/bin/bash
# Boot test of the built image with the real Smartnode daemon.
#
# Starts the image on a fixture /rocketpool volume in the 0.0.106 layout
# (placeholder wallet/password files, or a real wallet created with
# Smartnode v1.13.5 when BOOT_OLD_DAEMON is set) and
# checks that start-node.sh backs up, renders, passes the daemon's config
# load, and that the daemon gets as far as serving its HTTP API.
# There is no EL/CL on the test machine, so the daemon then waits for the
# execution client; that is expected.
#
# Usage: build/tests/boot-test.sh [image]   (default: the tag in docker-compose.yml)
# Writes the container log to $BOOT_LOG (default ./boot-test.log).
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${1:-$(sed -n "s/^ *image: '\\(.*\\)'$/\\1/p" "$ROOT/docker-compose.yml" | head -n1)}"
LOG="${BOOT_LOG:-$PWD/boot-test.log}"
WAIT="${BOOT_WAIT:-45}"
NAME="rp-boot-test-$$"
FIX="$(mktemp -d)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1; docker run --rm -v "$FIX:/f" busybox rm -rf /f/rocketpool >/dev/null 2>&1; rm -rf "$FIX"' EXIT

PASS=0
FAIL=0
check() {
    if eval "$2"; then PASS=$((PASS + 1)); echo "ok   $1"; else FAIL=$((FAIL + 1)); echo "FAIL $1"; fi
}

D="$FIX/rocketpool/data"
mkdir -p "$D/validators/teku/keys" "$D/validators/teku/passwords" "$D/validators/lighthouse/validators" "$D/rewards-trees"
printf '{"crypto":"placeholder, not a real wallet"}' >"$D/wallet"
printf 'placeholder-password' >"$D/password"
chmod 600 "$D/wallet" "$D/password"
printf '{"pubkey":"aa"}' >"$D/validators/teku/keys/0xaa.json"
printf 'pw' >"$D/validators/teku/passwords/0xaa.txt"
printf 'FEE_RECIPIENT=0x0000000000000000000000000000000000000001' >"$D/validators/rp-fee-recipient-env.txt"
printf 'legacy words' >"$D/mnemonic"
printf '[]' >"$D/transactions.json"
printf '{}' >"$D/rewards-trees/rp-rewards-mainnet-1.json"

# With BOOT_OLD_DAEMON=<path to rocketpoold v1.13.5 linux-amd64> the fixture
# gets a real wallet created the way package 0.0.106 did it (set-password,
# init, recover, mnemonic saved to data/mnemonic), replacing the placeholders.
EXPECT_ADDRESS=""
if [ -n "${BOOT_OLD_DAEMON:-}" ]; then
    cp "$BOOT_OLD_DAEMON" "$FIX/rocketpoold-old" && chmod +x "$FIX/rocketpoold-old"
    rm -f "$D/wallet" "$D/password" "$D/mnemonic"
    cat >"$FIX/old-settings.yml" <<'YML'
root:
  version: v1.13.5
  isNative: "true"
  rpDir: /f
  executionClientMode: external
  consensusClientMode: external
  externalConsensusClient: teku
  useFallbackClients: "false"
smartnode:
  network: mainnet
  dataPath: /f/rocketpool/data
native:
  ecHttpUrl: http://127.0.0.1:1
  ccHttpUrl: http://127.0.0.1:1
  consensusClient: teku
  validatorRestartCommand: /bin/true
  validatorStopCommand: /bin/true
YML
    EXPECT_ADDRESS="$(docker run --rm --platform linux/amd64 -v "$FIX:/f" node:22.23.2-bookworm-slim bash -c '
        R="/f/rocketpoold-old --settings /f/old-settings.yml api"
        $R wallet set-password "fixture-password-123" >/dev/null || exit 1
        m="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).mnemonic)" "$($R wallet init)")" || exit 1
        printf "%s" "$m" >/f/rocketpool/data/mnemonic
        $R wallet recover --skip-validator-key-recovery "$m" | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.parse(s).accountAddress))"
    ')"
    [ -n "$EXPECT_ADDRESS" ] && [ -s "$D/wallet" ] || { echo "could not create the v1.13.5 wallet fixture"; exit 1; }
    echo "v1.13.5 wallet fixture created: $EXPECT_ADDRESS"
fi

sums() { (cd "$D" && for f in wallet password mnemonic transactions.json validators/teku/keys/0xaa.json validators/teku/passwords/0xaa.txt; do sha256sum "$f"; done); }
BEFORE="$(sums)"

docker run -d --name "$NAME" --platform linux/amd64 \
    -e NETWORK=mainnet -e EXECUTIONCLIENT=geth -e CONSENSUSCLIENT=teku \
    -v "$FIX/rocketpool:/rocketpool" "$IMAGE" >/dev/null || exit 1
echo "waiting ${WAIT}s for $IMAGE ..."
sleep "$WAIT"

docker logs "$NAME" >"$LOG" 2>&1
IN() { docker exec "$NAME" sh -c "$1"; }
IN 'supervisorctl status' >>"$LOG" 2>&1 || true
{ echo "--- /tmp/avado-start-status.json"; IN 'cat /tmp/avado-start-status.json'; echo "--- /srv/rocketpool/user-settings.yml"; IN 'cat /srv/rocketpool/user-settings.yml'; } >>"$LOG" 2>&1

check "settings accepted by the config loader" "grep -q 'Settings accepted by Smartnode v1.24.2' '$LOG'"
check "daemon started in native mode" "grep -q 'Starting node daemon in Native Mode.' '$LOG'"
check "HTTP API on 127.0.0.1:8280" "grep -q 'Node HTTP API server listening on 127.0.0.1:8280' '$LOG'"
# The daemon waits for the EL silently (it only prints the EL error when it
# exits), so probe its API instead: /healthz and an authenticated read.
API_PROBE='const fs=require("fs");const t=JSON.parse(fs.readFileSync("/rocketpool/data/api-tokens.json","utf8")).tokens[0].token;
(async()=>{const h=await fetch("http://127.0.0.1:8280/healthz");const w=await fetch("http://127.0.0.1:8280/api/wallet/status",{headers:{Authorization:"Bearer "+t}});
const j=await w.json();console.log(h.status,w.status,JSON.stringify(j.error||j.status));})().catch(e=>{console.log("ERR",e.message)})'
PROBE_OUT="$(docker exec "$NAME" node -e "$API_PROBE" 2>&1)"
echo "--- API probe: $PROBE_OUT" >>"$LOG"
if [ -n "$EXPECT_ADDRESS" ]; then
    WPROBE='const fs=require("fs");const t=JSON.parse(fs.readFileSync("/rocketpool/data/api-tokens.json","utf8")).tokens[0].token;
fetch("http://127.0.0.1:8280/api/wallet/status",{headers:{Authorization:"Bearer "+t}}).then(r=>r.json()).then(j=>console.log(j.status,j.passwordSet,j.walletInitialized,j.accountAddress.toLowerCase()))'
    WOUT="$(docker exec "$NAME" node -e "$WPROBE" 2>&1)"
    echo "--- wallet/status: $WOUT" >>"$LOG"
    check "daemon API answers (healthz 200, wallet/status 200)" "[ \"\${PROBE_OUT%% \\\"*}\" = '200 200' ]"
    check "v1.24.2 reads the v1.13.5 wallet (same address)" "[ \"\$WOUT\" = \"success true true \$(echo \$EXPECT_ADDRESS | tr A-F a-f)\" ]"
else
    # Placeholder wallet: the API answers, wallet/status reports it can't decode it.
    check "daemon API answers (healthz 200, wallet/status 500 on the placeholder wallet)" "[ \"\${PROBE_OUT%% \\\"*}\" = '200 500' ]"
fi
check "no config error" "! grep -qi 'could not deserialize\\|error upgrading configuration' '$LOG'"
check "rocketpool-node RUNNING" "IN 'supervisorctl status rocketpool-node' | grep -q RUNNING"
check "PACKAGE_VERSION exported to supervisord (pid 1)" "IN 'tr \"\\000\" \"\\n\" </proc/1/environ' | grep -qx \"PACKAGE_VERSION=\$(IN 'cat /srv/rocketpool/package-version')\""
check "no startup error file" "! IN 'test -e /tmp/rocketpool-startup-error.txt'"
check "status state starting" "IN 'grep -q \"\\\"state\\\": \\\"starting\\\"\" /tmp/avado-start-status.json'"
check "daemon.log written" "IN 'grep -q \"Starting node daemon\" /var/log/rocketpool/daemon.log'"
check "api-tokens.json created in data dir" "IN 'test -s /rocketpool/data/api-tokens.json'"
check "one backup created" "[ \$(IN 'ls /rocketpool/backups' | wc -l) -eq 1 ]"
check "backup has wallet, password, validators, mnemonic, transactions.json" \
    "IN 'cd /rocketpool/backups/legacy-* && test -f wallet -a -f password -a -d validators -a -f mnemonic -a -f transactions.json'"
check "backup wallet identical" "IN 'cmp /rocketpool/data/wallet /rocketpool/backups/legacy-*/wallet'"
check "version marker written" "IN 'cat /rocketpool/data/.avado-package-version' | grep -qx \"\$(IN 'cat /srv/rocketpool/package-version')\""
check "wallet, password, keys unchanged" "[ \"\$(sums)\" = \"\$BEFORE\" ]"

echo "restart (same version: no new backup) ..."
docker restart "$NAME" >/dev/null
sleep 20
check "no second backup on restart" "[ \$(IN 'ls /rocketpool/backups' | wc -l) -eq 1 ]"
check "daemon running after restart" "IN 'supervisorctl status rocketpool-node' | grep -q RUNNING"
docker logs "$NAME" >"$LOG.restart" 2>&1

echo "passed: $PASS, failed: $FAIL (log: $LOG)"
[ "$FAIL" -eq 0 ]
