#!/bin/bash

# Check NETWORK value
case ${NETWORK} in
"mainnet" | "prater") ;;
*)
    echo "Invalid NETWORK configured"
    exit 1
    ;;
esac

# Check CONSENSUSCLIENT value
case ${CONSENSUSCLIENT} in
"teku" | "prysm" | "nimbus" | "lighthouse") ;;
*)
    echo "Invalid CONSENSUSCLIENT configured"
    exit 1
    ;;
esac

# Check EXECUTIONCLIENT value
case ${EXECUTIONCLIENT} in
"geth" | "nethermind") ;;
*)
    echo "Invalid EXECUTIONCLIENT configured"
    exit 1
    ;;
esac

# Set URLs based on configuration
if [ "${EXECUTIONCLIENT}" = "nethermind" ]; then
    ECHTTPURL="http://avado-dnp-nethermind.my.ava.do:8545"
    ECWSURL="ws://avado-dnp-nethermind.my.ava.do:8545"
else
    if [ "${NETWORK}" = "prater" ] || [ "${NETWORK}" = "holesky" ]; then
        ECHTTPURL="http://${NETWORK}-geth.my.ava.do:8545"
        ECWSURL="ws://${NETWORK}-geth.my.ava.do:8546"
    else
        ECHTTPURL="http://ethchain-geth.my.ava.do:8545"
        ECWSURL="http://ethchain-geth.my.ava.do:8546"
    fi
fi

if [ "${CONSENSUSCLIENT}" = "teku" ]; then
    if [ "${NETWORK}" = "prater" ] || [ "${NETWORK}" = "holesky" ]; then
        BCHTTPURL="http://teku-${NETWORK}.my.ava.do:5051"
    else
        BCHTTPURL="http://teku.my.ava.do:5051"
    fi
    BCJSONRPCURL=""
elif [ "${CONSENSUSCLIENT}" = "nimbus" ]; then
    if [ "${NETWORK}" = "prater" ] || [ "${NETWORK}" = "holesky" ]; then
        BCHTTPURL="http://nimbus-${NETWORK}.my.ava.do:5052"
    else
        BCHTTPURL="http://nimbus.my.ava.do:5052"
    fi
    BCJSONRPCURL=""
elif [ "${CONSENSUSCLIENT}" = "lighthouse" ]; then
    if [ "${NETWORK}" = "prater" ] || [ "${NETWORK}" = "holesky" ]; then
        BCHTTPURL="http://lighthouse--${NETWORK}.my.ava.do:5052"
    else
        BCHTTPURL="http://lighthouse.my.ava.do:5052"
    fi
    BCJSONRPCURL=""
else
    BCJSONRPCURL=""
    BCHTTPURL="http://prysm-beacon-chain-${NETWORK}.my.ava.do:3500"
    BCJSONRPCURL="http://prysm-beacon-chain-${NETWORK}.my.ava.do:4000"
fi

# Export variables and substitute them in the template
NETWORK="${NETWORK}" \
    CONSENSUSCLIENT="${CONSENSUSCLIENT}" \
    ECHTTPURL="${ECHTTPURL}" \
    ECWSURL="${ECWSURL}" \
    BCHTTPURL="${BCHTTPURL}" \
    BCJSONRPCURL="${BCJSONRPCURL}" \
    envsubst <"$(dirname "$0")/user-settings.template" >"$(dirname "$0")/user-settings.yml"

# Create folder for rewards trees
mkdir -p /rocketpool/data/rewards-trees/

# Start RocketPool node daemon
exec /usr/local/bin/rocketpoold --settings /srv/rocketpool/user-settings.yml node
