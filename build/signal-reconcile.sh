#!/bin/sh
# Smartnode's native.validatorRestartCommand and validatorStopCommand.
# Smartnode runs it after it changes the fee recipient file, after it stakes
# megapool validators, and on POST /api/service/restart-vc. It only signals
# the backend's key and fee-recipient reconciliation loop, which runs
# immediately when this file appears.
touch /tmp/reconcile-now
exit 0
