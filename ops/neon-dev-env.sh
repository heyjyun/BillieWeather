#!/usr/bin/env bash
# Configure this Mac's development servers for the shared Neon *development* branch.
#
#   ops/neon-dev-env.sh            # verify the branch in Neon, then write .env.local + services/identity-api/.env
#   ops/neon-dev-env.sh --check    # verify existing files only (used by ops/doctor.sh); changes nothing
#
# The credential comes straight from Neon through this Mac's own `neon auth` login. It is written only to
# the two git-ignored files (mode 600) and is never printed, logged or committed. Nothing is copied
# between Macs. See docs/dual-mac/DATABASE_ISOLATION.md.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID=sparkling-sun-34139417
BRANCH_NAME=development
BRANCH_ID=br-tiny-cherry-bdqrn2ge          # Neon metadata, verified below; not a secret
DEV_ENDPOINT=ep-cold-brook-bdbbvbj4
PRODUCTION_BRANCH_ID=br-damp-sea-bd1swyfw
PRODUCTION_ENDPOINT=ep-raspy-sound-bdlg3br7 # must never appear in development configuration
DATABASE=neondb
ROLE=neondb_owner
CA_BUNDLE=/etc/ssl/cert.pem                # macOS system trust store (libpq has no usable sslrootcert=system here)
RAILS_ENV_FILE=.env.local
IDENTITY_ENV_FILE=services/identity-api/.env

fail() { echo "neon-dev-env: $*" >&2; exit 1; }

check_files() {
  local found=0
  for f in .env .env.development .env.development.local "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE"; do
    [[ -e "$f" ]] || continue
    found=1
    ! grep -q "$PRODUCTION_ENDPOINT" "$f" || fail "$f names the production endpoint"
    [[ "$f" == "$RAILS_ENV_FILE" || "$f" == "$IDENTITY_ENV_FILE" ]] || fail "unexpected dotenv file $f"
    grep -qx "BILLIE_DB_ENV=development" "$f" || fail "$f does not pin BILLIE_DB_ENV=development"
    grep -qx "BILLIE_DB_HOST=$DEV_ENDPOINT\..*" "$f" || fail "$f does not pin the development endpoint"
    [[ "$(stat -f %Lp "$f")" == 600 ]] || fail "$f must be mode 600"
  done
  git ls-files --error-unmatch "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE" >/dev/null 2>&1 && fail "an env file is tracked by git"
  if [[ $found == 1 ]]; then echo "dotenv files target only the Neon development branch"; else echo "no dotenv files"; fi
}

if [[ "${1:-}" == "--check" ]]; then check_files; exit 0; fi

command -v neon >/dev/null || fail "install the Neon CLI (npm i -g neonctl) and run: neon auth"
command -v psql >/dev/null || fail "psql is required (brew install libpq or postgresql@18)"
neon me >/dev/null 2>&1 || fail "not signed in to Neon: run 'neon auth' first"

# 1. Identity from Neon metadata, not from the hostname.
neon branches get "$BRANCH_ID" --project-id "$PROJECT_ID" -o json | python3 -c '
import json, sys
b = json.load(sys.stdin); b = b.get("branch", b)
want = {"id": sys.argv[1], "name": sys.argv[2]}
if b.get("id") != want["id"] or b.get("name") != want["name"] or b.get("id") == sys.argv[3] or b.get("default"):
    sys.exit("neon-dev-env: Neon branch metadata does not match the development branch")
' "$BRANCH_ID" "$BRANCH_NAME" "$PRODUCTION_BRANCH_ID"
neon api "/projects/$PROJECT_ID/endpoints" | python3 -c '
import json, sys
eps = {e["id"]: e for e in json.load(sys.stdin)["endpoints"]}
e = eps.get(sys.argv[1])
if not e or e["branch_id"] != sys.argv[2] or e["type"] != "read_write":
    sys.exit("neon-dev-env: endpoint is not the development branch read-write endpoint")
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
print(p.hostname, p.username, u.unquote(p.password or ""), p.path.lstrip("/"), sep="\n")
' | { read -r host; read -r user; read -r pass; read -r db
      PGPASSWORD="$pass" psql "host=$host dbname=$db user=$user sslmode=verify-full sslrootcert=$CA_BUNDLE" -XAtq \
        -c "SELECT environment || ' ' || target_id FROM billie_release.target WHERE singleton"; })
[[ "$target_id" =~ ^development\ ([a-zA-Z0-9_-]{12,128})$ ]] || fail "the branch has no development marker (billie_release.target)"
target_id=${BASH_REMATCH[1]}

# 4. Write both files: database keys replaced, every other setting kept.
umask 077
[[ -f "$IDENTITY_ENV_FILE" ]] || cp services/identity-api/.env.example "$IDENTITY_ENV_FILE"
touch "$RAILS_ENV_FILE"
DIRECT="$direct" POOLED="$pooled" TARGET_ID="$target_id" python3 - "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE" <<PY
import os, re, sys
ca = "$CA_BUNDLE"; prod = "$PRODUCTION_ENDPOINT"; dev = "$DEV_ENDPOINT"
def tls(url):
    url = re.sub(r"([?&])sslrootcert=[^&]*&?", r"\1", url).rstrip("&?")
    url += ("&" if "?" in url else "?") + "sslrootcert=" + ca
    if "channel_binding=" not in url: url += "&channel_binding=require"
    return url
direct, pooled = tls(os.environ["DIRECT"]), tls(os.environ["POOLED"])
assert prod not in direct + pooled and dev + "." in direct and dev + "-pooler." in pooled, "unexpected connection host"
host = re.search(r"@([^/:?]+)", direct).group(1)
header = ["# Neon branch \"$BRANCH_NAME\" ($BRANCH_ID) — synthetic development data only. Written by",
          "# ops/neon-dev-env.sh. Never commit or copy this file. See docs/dual-mac/DATABASE_ISOLATION.md."]
pins = {"BILLIE_DB_ENV": "development", "BILLIE_DB_HOST": host, "BILLIE_DB_NAME": "$DATABASE",
        "BILLIE_DB_TARGET_ID": os.environ["TARGET_ID"]}
managed = set(pins) | {"DATABASE_URL", "DATABASE_URL_UNPOOLED", "PRIMARY_DATABASE_URL", "NEON_BRANCH", "NEON_BRANCH_ID"}
def write(path, values, extra_comment=None):
    kept = []
    for line in open(path).read().splitlines():
        key = line.split("=", 1)[0].strip()
        if key in managed or line.startswith("# Neon branch") or line.startswith("# ops/neon-dev-env.sh") \
           or prod in line:
            continue
        if path.endswith("identity-api/.env") and key == "IDENTITY_ENV":
            line = "IDENTITY_ENV=development"
        kept.append(line)
    while kept and not kept[0].strip():
        kept.pop(0)
    body = header + [f"{k}={v}" for k, v in values.items()] + [""] + kept
    open(path, "w").write("\n".join(body).rstrip("\n") + "\n")
write(sys.argv[1], {**pins, "DATABASE_URL": f'"{pooled}"', "DATABASE_URL_UNPOOLED": f'"{direct}"',
                    "NEON_BRANCH": "$BRANCH_NAME", "NEON_BRANCH_ID": "$BRANCH_ID"})
write(sys.argv[2], {**pins, "DATABASE_URL": pooled})
PY
chmod 600 "$RAILS_ENV_FILE" "$IDENTITY_ENV_FILE"
check_files
echo "Wrote $RAILS_ENV_FILE and $IDENTITY_ENV_FILE for Neon branch $BRANCH_NAME ($BRANCH_ID). Restart bin/dev and the identity API."
