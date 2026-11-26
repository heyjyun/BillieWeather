#!/usr/bin/env bash
# Configure this Mac's development servers for the separate BillieWeather Development project.
#
#   ops/neon-dev-env.sh            # verify the project in Neon, then write .env.local + services/identity-api/.env
#   ops/neon-dev-env.sh --check    # verify existing files only (used by ops/doctor.sh); changes nothing
#
# The credential comes straight from Neon through this Mac's own `neon auth` login. It is written only to
# the two git-ignored files (mode 600) and is never printed, logged or committed. Nothing is copied
# between Macs. See docs/dual-mac/DATABASE_ISOLATION.md.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID=odd-firefly-71205607
BRANCH_NAME=main
BRANCH_ID=br-tiny-brook-besd7lsc
DEV_ENDPOINT=ep-old-surf-be0dnct5
DEV_HOST=ep-old-surf-be0dnct5.c-9.us-east-2.aws.neon.tech
PRODUCTION_PROJECT_ID=sparkling-sun-34139417
PRODUCTION_ENDPOINT=ep-raspy-sound-bdlg3br7
DATABASE=billieweather_development
ROLE=billie_development_owner
TARGET_ID=billieweather-development-odd-firefly-71205607
CA_BUNDLE=/etc/ssl/cert.pem                # macOS system trust store (libpq has no usable sslrootcert=system here)
RAILS_ENV_FILE=.env.local
IDENTITY_ENV_FILE=services/identity-api/.env

fail() { echo "neon-dev-env: $*" >&2; exit 1; }

check_files() {
  local found=0
  for f in .env .env.development .env.development.local "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE"; do
    [[ -e "$f" ]] || continue
    [[ ! -L "$f" ]] || fail "$f is a symlink"
    found=$((found + 1))
    ! grep -q "$PRODUCTION_ENDPOINT" "$f" || fail "$f names the production endpoint"
    [[ "$f" == "$RAILS_ENV_FILE" || "$f" == "$IDENTITY_ENV_FILE" ]] || fail "unexpected dotenv file $f"
    grep -qx "BILLIE_DB_ENV=development" "$f" || fail "$f does not pin BILLIE_DB_ENV=development"
    grep -Fxq "BILLIE_DB_HOST=$DEV_HOST" "$f" || fail "$f does not pin the development endpoint"
    grep -Fxq "BILLIE_DB_NAME=$DATABASE" "$f" || fail "$f does not pin the development database"
    grep -Fxq "BILLIE_DB_TARGET_ID=$TARGET_ID" "$f" || fail "$f does not pin the development identity"
    python3 - "$f" "$DEV_HOST" "$ROLE" "$DATABASE" 2>/dev/null <<'CHECK' || fail "$f has an unexpected database URL"
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import sys

path, expected_host, role, db = sys.argv[1:]
expected_keys = {"DATABASE_URL"}
if path == ".env.local":
    expected_keys.add("DATABASE_URL_UNPOOLED")
seen = set()
for line in Path(path).read_text().splitlines():
    key, _, value = line.partition("=")
    key = key.strip().removeprefix("export ").strip()
    if key == "PRIMARY_DATABASE_URL":
        sys.exit(1)
    if key not in expected_keys:
        continue
    if key in seen:
        sys.exit(1)
    seen.add(key)
    url = urlsplit(value.strip().strip('"').strip("'"))
    endpoint, suffix = expected_host.split(".", 1)
    host = expected_host if key == "DATABASE_URL_UNPOOLED" else f"{endpoint}-pooler.{suffix}"
    if (url.scheme, url.hostname, url.username, url.path) != ("postgresql", host, role, "/" + db):
        sys.exit(1)
    if parse_qs(url.query).get("sslmode") != ["verify-full"]:
        sys.exit(1)
sys.exit(seen != expected_keys)
CHECK
    [[ "$(stat -f %Lp "$f")" == 600 ]] || fail "$f must be mode 600"
  done
  git ls-files --error-unmatch "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE" >/dev/null 2>&1 && fail "an env file is tracked by git"
  case "$found" in
    0) echo "no dotenv files" ;;
    2) echo "dotenv files target only the Neon Development project" ;;
    *) fail "expected both Development dotenv files" ;;
  esac
}

if [[ "${1:-}" == "--check" ]]; then check_files; exit 0; fi

for f in "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE"; do
  [[ ! -L "$f" ]] || fail "$f is a symlink"
  git check-ignore -q -- "$f" || fail "$f must be ignored by Git before writing credentials"
done
for f in .env .env.development .env.development.local; do
  [[ ! -e "$f" && ! -L "$f" ]] || fail "unexpected dotenv file $f"
done

command -v neon >/dev/null || fail "install the Neon CLI (npm i -g neonctl) and run: neon auth"
command -v psql >/dev/null || fail "psql is required (brew install libpq or postgresql@18)"
neon me >/dev/null 2>&1 || fail "not signed in to Neon: run 'neon auth' first"

# 1. Identity from Neon metadata.
[[ "$PROJECT_ID" != "$PRODUCTION_PROJECT_ID" ]] || fail "Development cannot use the Production project"
neon branches get "$BRANCH_ID" --project-id "$PROJECT_ID" -o json | python3 -c '
import json, sys
b = json.load(sys.stdin); b = b.get("branch", b)
want = {"id": sys.argv[1], "name": sys.argv[2]}
if b.get("id") != want["id"] or b.get("name") != want["name"] or not b.get("default") or b.get("parent_id"):
    sys.exit("neon-dev-env: Neon branch metadata does not match the development branch")
' "$BRANCH_ID" "$BRANCH_NAME"
neon api "/projects/$PROJECT_ID/endpoints" | python3 -c '
import json, sys
eps = {e["id"]: e for e in json.load(sys.stdin)["endpoints"]}
e = eps.get(sys.argv[1])
if not e or e["branch_id"] != sys.argv[2] or e["type"] != "read_write":
    sys.exit("neon-dev-env: endpoint is not the Development project read-write endpoint")
if eps.get(sys.argv[3], {}).get("branch_id") == sys.argv[2]:
    sys.exit("neon-dev-env: production endpoint attached to the development branch")
' "$DEV_ENDPOINT" "$BRANCH_ID" "$PRODUCTION_ENDPOINT"

# 2. Connection strings (kept in variables only).
direct=$(neon connection-string "$BRANCH_ID" --project-id "$PROJECT_ID" --role-name "$ROLE" --database-name "$DATABASE" --ssl verify-full)
pooled=$(neon connection-string "$BRANCH_ID" --project-id "$PROJECT_ID" --role-name "$ROLE" --database-name "$DATABASE" --ssl verify-full --pooled)

# 3. Server-side marker, read over the direct endpoint.
target_id=$(DIRECT="$direct" CA="$CA_BUNDLE" python3 -c '
import os, sys, urllib.parse as u
p = u.urlparse(os.environ["DIRECT"])
if p.hostname != sys.argv[1] or p.username != sys.argv[2] or p.path != "/" + sys.argv[3]:
    sys.exit("Unexpected Development connection metadata")
print(p.hostname, p.username, u.unquote(p.password or ""), p.path.lstrip("/"), sep="\n")
' "$DEV_HOST" "$ROLE" "$DATABASE" | { read -r host; read -r user; read -r pass; read -r db
      unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS
      PGPASSWORD="$pass" psql "host=$host dbname=$db user=$user sslmode=verify-full sslrootcert=$CA_BUNDLE" -XAtq \
        -c "SELECT environment || ' ' || target_id FROM billie_release.target WHERE singleton"; })
[[ "$target_id" == "development $TARGET_ID" ]] || fail "Development database marker mismatch"
target_id=$TARGET_ID

# 4. Write both files: database keys replaced, every other setting kept.
umask 077
[[ -f "$IDENTITY_ENV_FILE" ]] || cp services/identity-api/.env.example "$IDENTITY_ENV_FILE"
touch "$RAILS_ENV_FILE"
DIRECT="$direct" POOLED="$pooled" TARGET_ID="$target_id" python3 - "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE" <<PY
import os, re, sys, tempfile
ca = "$CA_BUNDLE"; prod = "$PRODUCTION_ENDPOINT"; dev = "$DEV_ENDPOINT"
def tls(url):
    url = re.sub(r"([?&])sslrootcert=[^&]*&?", r"\1", url).rstrip("&?")
    url += ("&" if "?" in url else "?") + "sslrootcert=" + ca
    if "channel_binding=" not in url: url += "&channel_binding=require"
    return url
direct, pooled = tls(os.environ["DIRECT"]), tls(os.environ["POOLED"])
assert prod not in direct + pooled and dev + "." in direct and dev + "-pooler." in pooled, "unexpected connection host"
host = re.search(r"@([^/:?]+)", direct).group(1)
header = ["# Neon Development project $PROJECT_ID ($BRANCH_ID) — synthetic data only. Written by",
          "# ops/neon-dev-env.sh. Never commit or copy this file. See docs/dual-mac/DATABASE_ISOLATION.md."]
pins = {"BILLIE_DB_ENV": "development", "BILLIE_DB_HOST": host, "BILLIE_DB_NAME": "$DATABASE",
        "BILLIE_DB_TARGET_ID": os.environ["TARGET_ID"]}
managed = set(pins) | {"DATABASE_URL", "DATABASE_URL_UNPOOLED", "PRIMARY_DATABASE_URL", "NEON_BRANCH", "NEON_BRANCH_ID"}
def write(path, values, extra_comment=None):
    kept = []
    for line in open(path).read().splitlines():
        key = line.split("=", 1)[0].strip().removeprefix("export ").strip()
        if key in managed or line.startswith("# Neon branch") or line.startswith("# ops/neon-dev-env.sh") \
           or line.startswith("# Neon Development project") or prod in line:
            continue
        if path.endswith("identity-api/.env") and key == "IDENTITY_ENV":
            line = "IDENTITY_ENV=development"
        kept.append(line)
    while kept and not kept[0].strip():
        kept.pop(0)
    body = header + [f"{k}={v}" for k, v in values.items()] + [""] + kept
    with tempfile.NamedTemporaryFile(mode="w", dir=os.path.dirname(path) or ".", delete=False) as output:
        output.write("\n".join(body).rstrip("\n") + "\n")
    os.replace(output.name, path)
write(sys.argv[1], {**pins, "DATABASE_URL": f'"{pooled}"', "DATABASE_URL_UNPOOLED": f'"{direct}"',
                    "NEON_BRANCH": "$BRANCH_NAME", "NEON_BRANCH_ID": "$BRANCH_ID"})
write(sys.argv[2], {**pins, "DATABASE_URL": pooled})
PY
chmod 600 "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE"
check_files
neon link --org-id org-orange-rain-26763420 --project-id "$PROJECT_ID" --branch "$BRANCH_ID" \
  --no-env-pull --no-config -y >/dev/null
echo "Configured the Neon Development project ($PROJECT_ID). Restart Rails and identity."
