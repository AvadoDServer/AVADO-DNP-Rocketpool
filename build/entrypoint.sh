#!/bin/sh
# Container entrypoint. Exports PACKAGE_VERSION (from dappnode_package.json,
# baked in at build time) so both supervisord programs see it, then runs
# supervisord in the foreground.
set -e
PACKAGE_VERSION="$(cat /srv/rocketpool/package-version)"
export PACKAGE_VERSION
exec supervisord --nodaemon --configuration /etc/supervisord.conf
