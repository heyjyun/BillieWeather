#!/usr/bin/env python3
"""BillieWeather database and Render operations. Pass credentials through the environment."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlsplit

DEV_PROJECT = "odd-firefly-71205607"
PROD_PROJECT = "sparkling-sun-34139417"
PROD_DIRECT_HOST = "ep-raspy-sound-bdlg3br7.c-8.us-east-2.aws.neon.tech"
DEV_HOST = "ep-old-surf-be0dnct5.c-9.us-east-2.aws.neon.tech"
DEV_TARGET = "billieweather-development-odd-firefly-71205607"
SERVICE = "srv-dbngjbrrjlhs738oms5g"
API = "https://web-68wd.onrender.com"
class OperationError(Exception):
    """An error message safe for the operator log."""


LOG_CAUSES = {
    "database_target": "does not match the approved database target",
    "database_marker": "billie_release.target",
    "missing_database_url": "Missing production DATABASE_URL",
    "database_authentication": "password authentication failed",
    "secret_key": "secret_key_base",
    "missing_command": "No such file or directory",
    "health_check": "Health check failed",
    "process_exit": "Exited with status",
}


def call(args, **kwargs):
    result = subprocess.run(args, stderr=subprocess.DEVNULL, check=False, **kwargs)
    if result.returncode:
        raise OperationError(f"{args[0]} exited with status {result.returncode}")
    return result


def read_json(args):
    return json.loads(call(args, stdout=subprocess.PIPE).stdout)


def db_config(read_only):
    env = os.environ
    url = urlsplit(env["DATABASE_URL_UNPOOLED"])
    kind = env["BILLIE_DB_ENV"]
    host = env["BILLIE_DB_HOST"]
    name = env["BILLIE_DB_NAME"]
    target = env["BILLIE_DB_TARGET_ID"]
    options = parse_qs(url.query, strict_parsing=True)
    connection_host = options.pop("host", [url.hostname])
    if (url.scheme not in {"postgres", "postgresql"} or connection_host != [host] or (url.hostname and url.hostname != host)
            or not url.username or unquote(url.path) != "/" + name or url.fragment
            or set(options) - {"sslmode", "sslrootcert", "channel_binding", "connect_timeout"}
            or any(len(values) != 1 for values in options.values())
            or not re.fullmatch(r"[A-Za-z0-9_-]{12,128}", target)):
        raise OperationError("Direct database URL and target pins do not match")
    if kind == "development":
        if (host, name, target) != (DEV_HOST, "billieweather_development", DEV_TARGET):
            raise OperationError("Development project pins do not match")
    elif kind == "local":
        socket_path = Path(host)
        private_socket = re.fullmatch(r"(?:/private)?/tmp/billie-roadmap\.[A-Za-z0-9]+/socket", host)
        if private_socket:
            stat = socket_path.parent.stat()
            private_socket = stat.st_uid == os.getuid() and not (stat.st_mode & 0o077)
        if (host not in {"localhost", "127.0.0.1", "::1"} and not private_socket) or not name.endswith(("_test", "_development")):
            raise OperationError("Local database requires loopback or a private QA socket and a development or test name")
    elif kind == "production":
        provider = env.get("BILLIE_DB_PROVIDER", "neon")
        is_neon = host == PROD_DIRECT_HOST and name == "neondb"
        is_postgres = re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*", host) and not host.endswith(".localhost")
        if not ((provider == "neon" and is_neon) or (provider == "postgres" and is_postgres)):
            raise OperationError("Production database pins do not match")
        if not read_only:
            raise OperationError("Refusing to restore into Production")
    else:
        raise OperationError("Unknown database environment")
    if kind != "local" and options.get("sslmode") != ["verify-full"]:
        raise OperationError("Remote direct database requires sslmode=verify-full")
    ps_env = {key: value for key, value in env.items() if not key.startswith("PG")}
    ps_env.update(PGHOST=host, PGPORT=str(url.port or 5432), PGDATABASE=name,
                  PGUSER=unquote(url.username), PGPASSWORD=unquote(url.password or ""),
                  PGCONNECT_TIMEOUT=options.get("connect_timeout", ["10"])[0])
    for option in ("sslmode", "sslrootcert", "channel_binding"):
        if option in options:
            ps_env["PG" + option.upper()] = options[option][0]
    if read_only:
        ps_env["PGOPTIONS"] = "-c default_transaction_read_only=on"
    return ps_env, kind, target


def sql(env, statement):
    return call(["psql", "-XAtw", "-v", "ON_ERROR_STOP=1", "-c", statement],
                env=env, stdout=subprocess.PIPE).stdout.decode().strip()


def verify_db(env, kind, target):
    actual = sql(env, """
      SELECT concat_ws('|', current_database(), current_user, environment, target_id)
      FROM billie_release.target WHERE singleton
    """)
    if actual != "|".join((env["PGDATABASE"], env["PGUSER"], kind, target)):
        raise OperationError("PostgreSQL did not confirm the expected environment")
    print(f"Database identity verified ({kind})")


def backup(path, recipient, before_marker=False):
    env, kind, target = db_config(read_only=True)
    if before_marker:
        if (kind, env["PGHOST"], env["PGDATABASE"], env["PGUSER"]) != (
            "production", PROD_DIRECT_HOST, "neondb", "neondb_owner"
        ):
            raise OperationError("Pre-marker backup requires the currently approved Production owner target")
        identity = sql(env, """
          SELECT concat_ws('|', current_database(), current_user,
             current_setting('transaction_read_only'),
             (to_regclass('billie_release.target') IS NULL)::text)
        """)
        if identity != "neondb|neondb_owner|on|true":
            raise OperationError("Expected the existing read-only Production database without a marker")
        print("Verified the pre-marker Production database for read-only backup")
    else:
        verify_db(env, kind, target)
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", recipient):
        raise OperationError("Use a verified GPG recipient fingerprint")
    # The destination becomes visible only after both pipeline steps succeeded.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        try:
            with subprocess.Popen(
                ["gpg", "--batch", "--recipient", recipient, "--encrypt"],
                stdin=subprocess.PIPE, stdout=temporary, stderr=subprocess.DEVNULL
            ) as gpg:
                header = {"format": 1, "environment": kind}
                gpg.stdin.write((json.dumps(header) + "\n").encode())
                gpg.stdin.flush()
                call(["pg_dump", "--no-password", "--format=custom", "--no-owner", "--no-acl",
                      "--exclude-schema=billie_release"], env=env, stdout=gpg.stdin)
                gpg.stdin.close()
                if gpg.wait():
                    raise OperationError("GPG encryption failed")
            os.fsync(temporary.fileno())
            os.link(temporary.name, path)
        finally:
            Path(temporary.name).unlink()
    print(f"Encrypted backup created at {path}")


def restore(path):
    env, kind, target = db_config(read_only=False)
    verify_db(env, kind, target)
    # Refuse to overwrite any application schema. Verify decryption before touching the database.
    if sql(env, """
      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('billie_release', 'pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_%'
    """) != "0":
        raise OperationError("Restore requires a separate empty database with a target marker")
    with tempfile.TemporaryFile() as archive:
        with subprocess.Popen(["gpg", "--batch", "--decrypt", str(path)],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as gpg:
            header = gpg.stdout.readline(4096)
            shutil.copyfileobj(gpg.stdout, archive)
            if gpg.wait() or json.loads(header) != {"format": 1, "environment": kind}:
                raise OperationError("Backup decryption failed or its environment does not match")
        archive.seek(0)
        call(["pg_restore", "--no-password", "--no-acl", "--no-owner", "--single-transaction",
              "--exit-on-error", "--dbname", env["PGDATABASE"]], env=env, stdin=archive,
             stdout=subprocess.DEVNULL)
    print("Restore completed in a single PostgreSQL transaction")


def render_service():
    items = read_json(["render", "services", "-o", "json"])
    for item in items:
        service = item.get("service", item)
        if service.get("id") == SERVICE:
            return service
    raise OperationError("BillieWeather Production absent from the active Render workspace")


def deploys():
    return [row.get("deploy", row) for row in read_json(["render", "deploys", "list", SERVICE, "-o", "json"])]


def diagnose(deploy):
    if not deploy.get("finishedAt"):
        return
    log = call(["render", "logs", "--resources", SERVICE, "--start", deploy["createdAt"],
                "--end", deploy["finishedAt"], "--limit", "500", "-o", "json"],
               stdout=subprocess.PIPE).stdout.decode().strip()
    decoder = json.JSONDecoder()
    labels = set()
    while log:
        row, end = decoder.raw_decode(log)
        log = log[end:].lstrip()
        for entry in row if isinstance(row, list) else row.get("logs", [row]):
            message = entry.get("message", "").lower()
            labels.update(name for name, phrase in LOG_CAUSES.items() if phrase.lower() in message)
    print(f"{deploy['id']} {deploy['status']} causes={','.join(sorted(labels)) or 'unclassified'}")


def health():
    routes = [("/up", 200), ("/api/client/v1/account", 401)]
    for path, expected in routes:
        result = call(["curl", "--silent", "--show-error", "--max-time", "90",
                       "--output", os.devnull, "--write-out", "%{http_code}", API + path],
                      stdout=subprocess.PIPE)
        status = int(result.stdout)
        if status != expected:
            raise OperationError(f"{path} returned {status}, expected {expected}")
        print(f"{path} {status}")


def release(commit):
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not os.getenv("BILLIE_RELEASE_APPROVAL", "").strip():
        raise OperationError("A full main commit SHA and an approved BILLIE_RELEASE_APPROVAL reference are required")
    service = render_service()
    if service.get("autoDeployTrigger") != "off" or service.get("branch") != "main":
        raise OperationError("Render must be on main with Auto-Deploy Off")
    call(["git", "fetch", "origin", "main"], stdout=subprocess.DEVNULL)
    call(["git", "merge-base", "--is-ancestor", commit, "origin/main"])
    for flag in ("buildCommand", "startCommand"):
        command = service["serviceDetails"]["envSpecificDetails"][flag]
        if command.startswith("./"):
            call(["git", "cat-file", "-e", f"{commit}:{command[2:]}"])
    db_env, kind, target = db_config(read_only=True)
    if kind != "production":
        raise OperationError("Release verification requires the Production database pins")
    verify_db(db_env, kind, target)
    if any(not deploy.get("finishedAt") and deploy["status"] not in {"live", "deactivated"}
           for deploy in deploys()):
        raise OperationError("A Render deployment is already in progress")
    deployed = read_json(["render", "deploys", "create", SERVICE, "--commit", commit, "--confirm", "-o", "json"])
    deploy_id = deployed.get("deploy", deployed)["id"]
    for _ in range(120):
        current = next((row for row in deploys() if row["id"] == deploy_id), None)
        if current and current["status"] == "live":
            print(f"{deploy_id} live")
            health()
            return
        if current and current.get("finishedAt"):
            diagnose(current)
            raise OperationError("Render deployment did not go live")
        time.sleep(10)
    raise OperationError(f"Timed out waiting for Render deployment {deploy_id}")


def quota():
    for project_id in (PROD_PROJECT, DEV_PROJECT):
        project = read_json(["neon", "api", f"/projects/{project_id}"])["project"]
        branches = read_json(["neon", "branches", "list", "--project-id", project_id, "-o", "json"])
        storage_limit = project.get("branch_logical_size_limit_bytes")
        largest_branch = max((branch.get("logical_size") or 0 for branch in branches), default=0)
        usage = {"compute_time_seconds": project.get("compute_time_seconds"),
                 "largest_branch_bytes": largest_branch,
                 "branches": len(branches)}
        limits = {"compute_time_seconds": 100 * 3600, "largest_branch_bytes": storage_limit, "branches": 10}
        alerts = [key for key, limit in limits.items() if limit and (usage[key] or 0) >= limit * 0.8]
        print(json.dumps({"project": project_id, "free_limits": limits, "alerts": alerts, **usage,
                          "data_transfer_bytes": project.get("data_transfer_bytes"),
                          "consumption_period_end": project.get("consumption_period_end")}))



def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    for command in ("db-check", "quota", "diagnose", "health"):
        commands.add_parser(command)
    commands.add_parser("deploy").add_argument("commit")
    commands.add_parser("rollback", help="Redeploy a compatible commit using current Render settings").add_argument("commit")
    commands.add_parser("restore").add_argument("file", type=Path)
    backup_cmd = commands.add_parser("backup")
    backup_cmd.add_argument("file", type=Path)
    backup_cmd.add_argument("--recipient", required=True)
    backup_cmd.add_argument("--before-marker", action="store_true")
    args = cli.parse_args()
    if args.command == "db-check":
        verify_db(*db_config(read_only=True))
    elif args.command == "backup":
        backup(args.file, args.recipient, args.before_marker)
    elif args.command == "restore":
        restore(args.file)
    elif args.command in {"deploy", "rollback"}:
        release(args.commit)
    elif args.command == "diagnose":
        for deploy in [item for item in deploys() if item["status"].endswith("_failed")][:3]:
            diagnose(deploy)
    elif args.command == "health":
        health()
    elif args.command == "quota":
        quota()


if __name__ == "__main__":
    try:
        main()
    except OperationError as error:
        raise SystemExit(str(error)) from None
    except (KeyError, OSError, ValueError) as error:
        # Exception text from parsing URLs or provider responses can contain credentials.
        raise SystemExit(f"Operation failed ({type(error).__name__})") from None
