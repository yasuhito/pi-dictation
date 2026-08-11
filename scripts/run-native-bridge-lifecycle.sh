#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo 'Native Bridge lifecycle certification requires macOS.' >&2
  exit 1
fi

if [ "${1:-}" = "real-device" ]; then
  shift
  exec node bin/pi-dictation-bridge-certify.cjs "$@"
fi
if [ "$#" -ne 0 ]; then
  echo 'Usage: scripts/run-native-bridge-lifecycle.sh [real-device list [--json]|real-device prepare SCENARIO [ssh-alias]|real-device verify [--confirm]]' >&2
  exit 1
fi

baseline=$(mktemp /tmp/pi-dictation-lifecycle-baseline.XXXXXX)
find /tmp -maxdepth 1 -type d -name 'pdn-*' -print | sort > "$baseline"
cleanup() {
  current=$(mktemp /tmp/pi-dictation-lifecycle-current.XXXXXX)
  find /tmp -maxdepth 1 -type d -name 'pdn-*' -print | sort > "$current"
  comm -13 "$baseline" "$current" | while IFS= read -r directory; do
    [ -n "$directory" ] && rm -rf "$directory"
  done
  rm -f "$baseline" "$current"
}
trap cleanup EXIT HUP INT TERM

cat <<'SCENARIOS'
Certifying isolated native fault scenarios with synthetic PCM:
- owner-liveness loss and retained-result cleanup
- sleep, logout, reboot, session lock, companion stop, companion restart, and device loss
- no automatic resume after recovery events
- companion-to-watchdog deadline and exact-instance force termination
No real microphone is opened and every isolated runtime is removed after its scenario.
SCENARIOS

# Run the complete native process-interface suites rather than selecting tests by
# display name. Their harnesses launch production protocol binaries and always
# remove the isolated runtime; the EXIT trap provides a second cleanup boundary.
node --test test/native-companion.test.cjs test/native-companion-integration.test.cjs

leftovers=$(mktemp /tmp/pi-dictation-lifecycle-leftovers.XXXXXX)
current=$(mktemp /tmp/pi-dictation-lifecycle-current.XXXXXX)
find /tmp -maxdepth 1 -type d -name 'pdn-*' -print | sort > "$current"
comm -13 "$baseline" "$current" > "$leftovers"
if [ -s "$leftovers" ]; then
  cat "$leftovers" >&2
  rm -f "$leftovers" "$current"
  echo 'Lifecycle certification left an isolated runtime; cleanup will remove it.' >&2
  exit 1
fi
rm -f "$leftovers" "$current"
echo 'Lifecycle certification passed with no retained isolated audio runtime.'
