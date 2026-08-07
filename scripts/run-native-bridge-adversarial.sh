#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "The production companion adversarial suite requires macOS." >&2
  exit 1
fi

root="$HOME/Library/Application Support/pi-dictation/bridge"
runtime="$HOME/Library/Caches/pi-dictation/bridge"
label="com.yasuhito.pi-dictation.bridge"
domain="gui/$(id -u)"
app="$root/PiDictationBridge.app"
preflight="$root/preflight.json"
primary="$root/credential.json"
host="$root/hosts/19ad000000000000"
temporary=$(mktemp -d /tmp/pi-dictation-native-security.XXXXXX)

for required in "$app" "$preflight" "$primary"; do
  if [ ! -e "$required" ]; then
    echo "Install and preflight the Mac companion before running the native adversarial suite." >&2
    rm -rf "$temporary"
    exit 1
  fi
done
if [ -e "$host" ]; then
  echo "Refusing to replace the native adversarial test credential directory." >&2
  rm -rf "$temporary"
  exit 1
fi

cp -a "$app" "$temporary/original.app"
cp "$preflight" "$temporary/preflight.json"
restore() {
  set +e
  launchctl kill SIGTERM "$domain/$label" >/dev/null 2>&1
  sleep 1
  rm -rf "$app"
  cp -a "$temporary/original.app" "$app"
  cp "$temporary/preflight.json" "$preflight"
  chmod 600 "$preflight"
  rm -rf "$host"
  launchctl kickstart -k "$domain/$label" >/dev/null 2>&1
  rm -rf "$temporary"
}
trap restore EXIT HUP INT TERM

node bin/pi-dictation.mjs bridge build --output "$temporary/test.app" >/dev/null
sdk=$(xcrun --sdk macosx --show-sdk-path)
xcrun swiftc -O -whole-module-optimization -D PROTOCOL_TESTING \
  -sdk "$sdk" -target arm64-apple-macosx14.0 \
  -framework AVFoundation -framework AudioToolbox -framework CoreMedia \
  -framework CryptoKit -framework Security \
  native/macos-companion/PiDictationBridge.swift \
  -o "$temporary/test.app/Contents/MacOS/PiDictationBridge"
chmod 700 "$temporary/test.app/Contents/MacOS/PiDictationBridge"
codesign --force --sign - "$temporary/test.app" >/dev/null

launchctl kill SIGTERM "$domain/$label" >/dev/null 2>&1 || true
sleep 1
rm -rf "$app"
cp -a "$temporary/test.app" "$app"
digest=$(shasum -a 256 "$app/Contents/MacOS/PiDictationBridge" | awk '{print $1}')
node -e 'const fs=require("fs");const p=process.argv[1],d=process.argv[2];const x=JSON.parse(fs.readFileSync(p));x.executableSha256=d;fs.writeFileSync(p,JSON.stringify(x)+"\n",{mode:0o600})' "$preflight" "$digest"

mkdir -p "$host"
chmod 700 "$root/hosts" "$host"
node -e 'const fs=require("fs"),c=require("crypto");fs.writeFileSync(process.argv[1],JSON.stringify({id:c.randomUUID(),secret:c.randomBytes(32).toString("base64")})+"\n",{mode:0o600})' "$host/credential.json"
chmod 600 "$host/credential.json"

launchctl kickstart -k "$domain/$label"
index=0
while [ ! -S "$runtime/companion.sock" ] && [ "$index" -lt 50 ]; do
  sleep 0.1
  index=$((index + 1))
done
test -S "$runtime/companion.sock"

PI_DICTATION_NATIVE_COMPANION_SOCKET="$runtime/companion.sock" \
PI_DICTATION_NATIVE_CREDENTIAL_FILES="$primary:$host/credential.json" \
node --test test/native-bridge-adversarial.test.cjs
