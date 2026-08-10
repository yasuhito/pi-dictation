#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "The isolated native companion adversarial suite requires macOS." >&2
  exit 1
fi

temporary=$(mktemp -d /tmp/pi-dictation-native-security.XXXXXX)
companion_pid=
cleanup() {
  set +e
  if [ -n "$companion_pid" ]; then
    kill "$companion_pid" >/dev/null 2>&1
    wait "$companion_pid" >/dev/null 2>&1
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

# Verify the production build as well as the test-mode binary used below.
node bin/pi-dictation.mjs bridge build --output "$temporary/production.app" >/dev/null
sdk=$(xcrun --sdk macosx --show-sdk-path)
xcrun swiftc -O -whole-module-optimization -parse-as-library -D PROTOCOL_TESTING \
  -sdk "$sdk" -target arm64-apple-macosx14.0 \
  -framework AVFoundation -framework AudioToolbox -framework CoreMedia \
  -framework CryptoKit -framework Security \
  native/macos-companion/PiDictationBridge.swift \
  -o "$temporary/PiDictationBridge"
chmod 700 "$temporary/PiDictationBridge"

state="$temporary/state"
root="$state/root"
runtime="$state/runtime"
host="$root/hosts/19ad000000000000"
mkdir -p "$host" "$runtime"
chmod 700 "$root" "$root/hosts" "$host" "$runtime"
digest=$(shasum -a 256 "$temporary/PiDictationBridge" | awk '{print $1}')
node - "$root" "$host" "$digest" <<'NODE'
const { randomBytes, randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [root, host, digest] = process.argv.slice(2);
const product = "com.yasuhito.pi-dictation.bridge";
const installId = randomUUID();
const credential = () => ({ id: randomUUID(), secret: randomBytes(32).toString("base64") });
writeFileSync(join(root, "ownership.json"), JSON.stringify({ product, installId }), { mode: 0o600 });
writeFileSync(join(root, "preflight.json"), JSON.stringify({ product, installId, executableSha256: digest }), { mode: 0o600 });
writeFileSync(join(root, "credential.json"), JSON.stringify(credential()), { mode: 0o600 });
writeFileSync(join(host, "credential.json"), JSON.stringify(credential()), { mode: 0o600 });
NODE
chmod 600 "$root/ownership.json" "$root/preflight.json" "$root/credential.json" "$host/credential.json"

PI_DICTATION_PROTOCOL_TEST_ROOT="$state" \
PI_DICTATION_PROTOCOL_TEST_REGISTRY_BYTES=524288 \
"$temporary/PiDictationBridge" >"$temporary/companion.log" 2>&1 &
companion_pid=$!
index=0
while [ ! -S "$runtime/companion.sock" ] && kill -0 "$companion_pid" >/dev/null 2>&1 && [ "$index" -lt 50 ]; do
  sleep 0.1
  index=$((index + 1))
done
if [ ! -S "$runtime/companion.sock" ]; then
  cat "$temporary/companion.log" >&2
  exit 1
fi

if ! PI_DICTATION_NATIVE_COMPANION_SOCKET="$runtime/companion.sock" \
  PI_DICTATION_NATIVE_CREDENTIAL_FILES="$root/credential.json:$host/credential.json" \
  node --test test/native-bridge-adversarial.test.cjs; then
  cat "$temporary/companion.log" >&2
  exit 1
fi
