#!/usr/bin/env bash
# Builds a stable BillieWeather release on the development Mac (the Mac mini).
#   BILLIE_API_URL=… BILLIE_IDENTITY_URL=… ops/release-build.sh [--skip-tests]
#
# Gates, in order: clean tree at a release tag (vX.Y.Z[-pre]) whose version matches Cargo/Tauri;
# release notes present; test suites pass; two clean builds give the same executable; package.mjs
# writes the DMG and its manifest. Output (never committed):
#   ~/BillieWeather-Releases/<version>/  BillieWeather-<version>.dmg  manifest.json  compat.json
#                                        SHA256SUMS  RELEASE_NOTES.md
# Copy that folder to the MacBook and run ops/install-stable.sh there (no toolchain needed).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; OUT_BASE="${BILLIE_RELEASE_DIR:-$HOME/BillieWeather-Releases}"
die() { printf 'release-build: %s\n' "$*" >&2; exit 1; }
eval "$(mise activate bash 2>/dev/null)" || true

# 1. source: clean, tagged, versions agree
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
TAG="$(git describe --tags --exact-match 2>/dev/null)" || die "HEAD is not at a release tag (git tag -a v<version>)"
VERSION="${TAG#v}"
CARGO_V="$(sed -nE 's/^version = "(.*)"/\1/p' clients/universal/src-tauri/Cargo.toml | head -1)"
TAURI_V="$(node - <<'JS'
const path = require("node:path");
const config = path.resolve("clients/universal/src-tauri/tauri.conf.json");
const version = require(config).version;
console.log(version.endsWith(".json") ? require(path.resolve(path.dirname(config), version)).version : version);
JS
)"
[[ "$VERSION" == "$CARGO_V" && "$VERSION" == "$TAURI_V" ]] || die "tag $VERSION, Cargo $CARGO_V, tauri.conf $TAURI_V disagree"
NOTES="docs/releases/$VERSION.md"; [[ -f "$NOTES" ]] || die "missing $NOTES"
REV="$(git rev-parse HEAD)"

# 2. servers the installed app will talk to
: "${BILLIE_API_URL:?set BILLIE_API_URL (the stable account server)}"
: "${BILLIE_IDENTITY_URL:?set BILLIE_IDENTITY_URL to the verified hosted Identity URL}"
node - "$BILLIE_API_URL" "$BILLIE_IDENTITY_URL" <<'JS' || die "Stable requires two verified HTTPS service origins"
for (const value of process.argv.slice(2)) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) process.exit(1);
}
const [api, identity] = process.argv.slice(2);
(async () => {
  const request = (origin, path) => fetch(new URL(path, origin), { redirect: "error", signal: AbortSignal.timeout(90000) });
  const [apiHealth, identityHealth] = await Promise.all([request(api, "/up"), request(identity, "/health")]);
  if (!apiHealth.ok || !identityHealth.ok) throw new Error("service health check failed");
  const result = await request(identity, "/v1/config");
  if (!result.ok) throw new Error("Identity configuration is unavailable");
  const config = await result.json();
  if (!config.registration_open || config.email_verification !== "required" || config.mail_delivery !== "postmark")
    throw new Error("Identity is not ready for verified email registration");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS

# 3. tests
if [[ "${1:-}" != --skip-tests ]]; then ops/doctor.sh --tests || die "tests failed"; fi

# 4. two clean builds must produce the same executable
WORK="$(mktemp -d /tmp/billie-release.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT
export CARGO_TARGET_DIR="$WORK/target" BILLIE_SOURCE_REVISION="$REV"
APP="$WORK/target/release/bundle/macos/BillieWeather.app"; SUMS=()
for n in 1 2; do
  (cd clients/universal/src-tauri && cargo clean -p billieweather --release >/dev/null 2>&1 || true)
  (cd clients/universal && node scripts/tauri.mjs build --bundles app) >"$WORK/build-$n.log" 2>&1 || { tail -30 "$WORK/build-$n.log"; die "build $n failed"; }
  SUMS+=("$(shasum -a 256 "$APP/Contents/MacOS/billieweather" | cut -d' ' -f1)")
done
[[ "${SUMS[0]}" == "${SUMS[1]}" ]] || die "builds differ (${SUMS[0]} vs ${SUMS[1]}): not reproducible"
ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
[[ "$ID" == com.billieweather.client ]] || die "built $ID, expected com.billieweather.client"

# 5. package, checksums, compatibility record
OUT="$OUT_BASE/$VERSION"; [[ ! -e "$OUT" ]] || die "$OUT already exists (a version is built once)"
mkdir -p "$OUT"
set +e; (cd clients/universal && node scripts/package.mjs "$APP" "$WORK/pkg"); PKG=$?; set -e
[[ $PKG == 0 || $PKG == 2 ]] || die "packaging failed"
cp "$WORK"/pkg/*.dmg "$OUT/BillieWeather-$VERSION.dmg"; cp "$WORK"/pkg/*.dmg.json "$OUT/manifest.json"
PACKAGED_SHA="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).executableSha256)' "$OUT/manifest.json")"
[[ "$PACKAGED_SHA" =~ ^[a-f0-9]{64}$ ]] || die "packaged executable checksum missing"
cp "$NOTES" "$OUT/RELEASE_NOTES.md"
SCHEMA="$(ls clients/universal/src-tauri/migrations | sed -nE 's/^0*([0-9]+)_.*/\1/p' | sort -n | tail -1)"
cat >"$OUT/compat.json" <<JSON
{ "version": "$VERSION", "tag": "$TAG", "sourceRevision": "$REV",
  "databaseSchema": $SCHEMA, "upgradesFromSchemaAtLeast": 1,
  "olderAppsCanOpenAfterUpgrade": false,
  "executableSha256": "$PACKAGED_SHA", "apiUrl": "$BILLIE_API_URL", "identityUrl": "$BILLIE_IDENTITY_URL",
  "builtOn": "$(scutil --get LocalHostName 2>/dev/null || hostname -s)", "builtAt": "$(date -u +%FT%TZ)" }
JSON
(cd "$OUT" && shasum -a 256 "BillieWeather-$VERSION.dmg" manifest.json compat.json RELEASE_NOTES.md > SHA256SUMS)
echo; echo "Release $VERSION ready in $OUT"; (( PKG == 2 )) && echo "Note: no Developer ID / notarization — personal ad hoc release (see manifest.json blockers)."
cat "$OUT/SHA256SUMS"
