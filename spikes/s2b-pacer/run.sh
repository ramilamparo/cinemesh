#!/bin/sh
# One S2b run in a fresh rootless session (user + mount + net + pid namespaces, scripts/netns-rootless.sh): no sudo,
# and every namespace, testnet and member dies with the session.
#   spikes/s2b-pacer/run.sh --out DIR --label NAME [run.ts options]
set -eu
cd "$(dirname "$0")/../.."
exec timeout 600 scripts/netns-rootless.sh node --import tsx spikes/s2b-pacer/run.ts "$@"
