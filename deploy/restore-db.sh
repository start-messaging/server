#!/usr/bin/env bash
# deploy/restore-db.sh <production|staging> <dump file> [options]
#
#   --into <database>          restore into another database owned by the env's
#                              role, for a rehearsal or a drill. The env's own
#                              database and its API are not touched. Create it
#                              first: sudo -u postgres createdb -O sms_<env> \
#                                --template template0 --locale en_US.UTF-8 <database>
#   --exclude-extension NAME   leave an extension out of the restore: one the app
#                              does not use and the env's role may not create
#                              (e.g. pg_stat_statements from RDS). Repeatable.
#   --no-safety-backup         skip the dump of the database being replaced
#   --yes                      do not ask for the env name (or SMS_RESTORE_CONFIRM=<env>)
#
# Replaces one environment's database on the StartMessaging EC2 box with a
# pg_dump custom-format archive (from deploy/backup-db.sh, from RDS, or from
# the old box's local Postgres), as the deploy user, with the env's own role
# (from its .env). Installed by the box bootstrap at /srv/sms/bin/restore-db.sh.
#
# It is how this API's database moved onto the box (the migration runbook)
# and how a bad migration is undone there (PRODUCTION-DEPLOY.md):
#
#   1. refuses unless the .env's database is on THIS box. A restore drops
#      everything first; pointed at RDS through a stray .env it would wipe
#      production.
#   2. refuses while the env's API is running under pm2 (sms-app.sh stop <env>).
#   3. checks the archive: pg_restore can list it, and every extension it
#      creates is one this role may create here (trusted, e.g. uuid-ossp and
#      pg_trgm, the two the migrations use) or is excluded.
#   4. asks for the env name, then takes a safety dump of the database it is
#      about to replace (when that has any tables).
#   5. in ONE transaction: drops and recreates schema public, then replays the
#      archive. Any error rolls back to exactly what was there.
#   6. ANALYZE (pg_restore does not carry planner statistics, and a cold
#      planner on a freshly loaded database is how a cutover gets slow), then
#      reports the tables and the migrations the database has recorded.
#
# It never starts the API.
set -Eeuo pipefail
umask 077

SMS_ROOT="${SMS_ROOT:-/srv/sms}"
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

log() { printf '%s [sms-restore %s] %s\n' "$(date -u +%FT%TZ)" "${ENV_NAME:-?}" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}
usage() {
	echo "usage: $(basename "$0") <production|staging> <dump file> [--into <db>] [--exclude-extension NAME]... [--no-safety-backup] [--yes]" >&2
	exit 64
}

[ $# -ge 2 ] || usage
ENV_NAME=$1
DUMP=$2
shift 2
INTO=""
SAFETY=1
ASSUME_YES=0
EXCLUDE=()
while [ $# -gt 0 ]; do
	case "$1" in
	--into)
		[ $# -ge 2 ] || usage
		INTO=$2
		shift 2
		;;
	--exclude-extension)
		[ $# -ge 2 ] || usage
		EXCLUDE+=("$2")
		shift 2
		;;
	--no-safety-backup)
		SAFETY=0
		shift
		;;
	--yes)
		ASSUME_YES=1
		shift
		;;
	*) usage ;;
	esac
done
case "$ENV_NAME" in
production) APP=startmessaging-server ;;
staging) APP=startmessaging-staging ;;
*) usage ;;
esac
[ "$(id -u)" -ne 0 ] || die "run as the deploy user (sudo -iu deploy), not root"
[ -z "$INTO" ] || [[ "$INTO" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--into must be a plain database name"
for ext in "${EXCLUDE[@]}"; do
	[[ "$ext" =~ ^[A-Za-z0-9_-]+$ ]] || die "not an extension name: $ext"
done
[ -f "$DUMP" ] || die "no such file: $DUMP"

# Same reader as deploy/backup-db.sh: never sources the file.
env_get() {
	local line value
	line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" | tail -n 1 || true)
	[ -n "$line" ] || return 1
	value=${line#*=}
	case $value in
	\"*\")
		value=${value#\"}
		value=${value%\"}
		;;
	\'*\')
		value=${value#\'}
		value=${value%\'}
		;;
	*)
		value=${value%%[[:space:]]#*}
		value=${value%"${value##*[![:space:]]}"}
		;;
	esac
	printf '%s' "$value"
}

HOME_DIR=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$ENV_NAME" in
production) CHECKOUT="$HOME_DIR/server" ;;
staging) CHECKOUT="$HOME_DIR/server-staging" ;;
esac
APP_ENV="$CHECKOUT/.env"
[ -r "$APP_ENV" ] || die "missing $APP_ENV (bring the .env over and run localize-env.sh $ENV_NAME first)"

DB_HOST=$(env_get "$APP_ENV" DATABASE_HOST) || die "DATABASE_HOST not set in $APP_ENV"
case "$DB_HOST" in
127.0.0.1 | localhost | ::1) ;;
*) die "$APP_ENV points at database host '$DB_HOST', not this box. A restore starts by dropping everything; it only ever runs against this box's own Postgres." ;;
esac
DB_PORT=$(env_get "$APP_ENV" DATABASE_PORT) || DB_PORT=5432
DB_NAME=$(env_get "$APP_ENV" DATABASE_NAME) || die "DATABASE_NAME not set in $APP_ENV"
DB_USER=$(env_get "$APP_ENV" DATABASE_USERNAME) || die "DATABASE_USERNAME not set in $APP_ENV"
DB_PASS=$(env_get "$APP_ENV" DATABASE_PASSWORD) || die "DATABASE_PASSWORD not set in $APP_ENV"
TARGET=${INTO:-$DB_NAME}

psql_target() {
	(
		export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" PGPASSWORD="$DB_PASS" \
			PGSSLMODE=disable PGCONNECT_TIMEOUT=15
		psql -X -v ON_ERROR_STOP=1 -d "$TARGET" "$@"
	)
}
sql() { psql_target -A -t -c "$1"; }

WORK="$SMS_ROOT/$ENV_NAME/backups"
if [ ! -d "$WORK" ] || [ ! -w "$WORK" ]; then
	die "$WORK is missing or not writable (the box bootstrap creates it)"
fi
RESTORE_LIST="" PROLOGUE="" SQL_FILE=""
trap 'rm -f "$RESTORE_LIST" "$PROLOGUE" "$SQL_FILE"' EXIT

# The same lock backup-db.sh takes: no nightly dump may read the database
# while it is being replaced. The safety dump below runs under it.
exec 9>"$SMS_ROOT/$ENV_NAME/.backup.lock"
flock -w 600 9 || die "a dump of $ENV_NAME is running (lock held for 10 min); retry when it finishes"

# ---------------------------------------------------------------- 1-2 preflight
sql 'SELECT 1' >/dev/null || die "cannot connect to $TARGET on $DB_HOST:$DB_PORT as $DB_USER"
if [ -z "$INTO" ] && command -v pm2 >/dev/null; then
	state=$(env -i HOME="$HOME_DIR" PATH=/usr/local/bin:/usr/bin:/bin pm2 jlist 9>&- 2>/dev/null | sed -n '/^\[/,$p' |
		jq -r --arg n "$APP" 'first(.[] | select(.name == $n) | .pm2_env.status) // "absent"' || echo unknown)
	case "$state" in
	absent | stopped | errored) ;;
	*) die "$APP is '$state' under pm2. Stop it first: $SMS_ROOT/bin/sms-app.sh stop $ENV_NAME" ;;
	esac
fi

# ---------------------------------------------------------------- 3 the archive
LIST=$(pg_restore --list "$DUMP") || die "$DUMP is not a pg_dump custom-format archive"
SOURCE_VERSION=$(sed -n 's/^;[[:space:]]*Dumped from database version: //p' <<<"$LIST" | head -n 1)
ENTRIES=$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' <<<"$LIST" || true)
mapfile -t EXTENSIONS < <(awk '$4 == "EXTENSION" && $5 == "-" { print $6 }' <<<"$LIST" | sort -u)
[ "$ENTRIES" -gt 0 ] || die "$DUMP holds no table data"

needs_superuser=()
for ext in "${EXTENSIONS[@]}"; do
	[[ "$ext" =~ ^[A-Za-z0-9_-]+$ ]] || die "unexpected extension name in the archive: $ext"
	[ "$ext" = plpgsql ] && continue
	excluded=0
	for x in "${EXCLUDE[@]}"; do [ "$x" = "$ext" ] && excluded=1; done
	[ "$excluded" = 1 ] && continue
	# NULL: not installable on this box at all. f: needs a superuser.
	trusted=$(sql "SELECT bool_or(trusted) FROM pg_available_extension_versions WHERE name = '$ext'")
	case "$trusted" in
	t) ;;
	f) needs_superuser+=("$ext (installable, but not trusted: needs a superuser)") ;;
	*) needs_superuser+=("$ext (not available on this box)") ;;
	esac
done
if [ "${#needs_superuser[@]}" -gt 0 ]; then
	die "the archive creates extensions $DB_USER cannot create here: ${needs_superuser[*]}. If the app does not use one, re-run with --exclude-extension <name>."
fi
if [ "${#EXCLUDE[@]}" -gt 0 ]; then
	RESTORE_LIST=$(mktemp "$WORK/.restore-list.XXXXXX")
	pattern=$(
		IFS='|'
		echo "${EXCLUDE[*]}"
	)
	grep -vE "^[0-9]+; [0-9]+ [0-9]+ (EXTENSION - ($pattern)|COMMENT - EXTENSION \"?($pattern)\"?)( |$)" <<<"$LIST" >"$RESTORE_LIST"
fi

# ---------------------------------------------------------------- 4 confirm + safety dump
CURRENT_TABLES=$(sql "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
cat >&2 <<EOF
==========================================================================
  RESTORE  $DUMP
           $(stat -c %s "$DUMP") bytes, $ENTRIES tables, from Postgres ${SOURCE_VERSION:-?}
           extensions: ${EXTENSIONS[*]:-none}${EXCLUDE[*]:+ (excluding: ${EXCLUDE[*]})}
  INTO     database "$TARGET" on this box (env $ENV_NAME, role $DB_USER),
           which has $CURRENT_TABLES tables now. Every one of them is REPLACED.
  Safety dump first: $(if [ -n "$INTO" ] || [ "$CURRENT_TABLES" -eq 0 ]; then echo "not needed"; elif [ "$SAFETY" = 1 ]; then echo yes; else echo "NO (--no-safety-backup)"; fi)
==========================================================================
EOF
if [ "$ASSUME_YES" != 1 ] && [ "${SMS_RESTORE_CONFIRM:-}" != "$ENV_NAME" ]; then
	answer=""
	read -r -p "Type the environment name ($ENV_NAME) to continue: " answer </dev/tty ||
		die "no terminal to confirm on; pass --yes (or SMS_RESTORE_CONFIRM=$ENV_NAME) to run unattended"
	[ "$answer" = "$ENV_NAME" ] || die "not confirmed; nothing was changed"
fi
if [ -z "$INTO" ] && [ "$CURRENT_TABLES" -gt 0 ] && [ "$SAFETY" = 1 ]; then
	[ -x "$HERE/backup-db.sh" ] || die "$HERE/backup-db.sh not found for the safety dump (--no-safety-backup to go without, knowingly)"
	log "safety dump of $TARGET before replacing it"
	SAFETY_FILE=$(SMS_BACKUP_LOCK_HELD=1 "$HERE/backup-db.sh" "$ENV_NAME" pre-restore 9>&-) ||
		[ $? -eq 3 ] || die "the safety dump failed; nothing was changed"
	log "safety dump: ${SAFETY_FILE:-(none)}"
fi

# ---------------------------------------------------------------- 5 restore
# Rendered to SQL first and replayed by psql from files, never piped: a
# pg_restore that died mid-stream would hand psql an early EOF, and psql would
# COMMIT the prefix it had. Read from a file, a short read is an error, and
# ON_ERROR_STOP turns it into a ROLLBACK. The rendered SQL is about the size of
# the data; with the WAL the single transaction writes, ~3x the archive.
AVAIL=$(df -B1 --output=avail "$WORK" | tail -n 1 | tr -d ' ')
NEED=$(($(stat -c %s "$DUMP") * 3 + 1073741824))
[ "$AVAIL" -gt "$NEED" ] || die "only $AVAIL bytes free in $WORK; the restore needs about $NEED"
PROLOGUE=$(mktemp "$WORK/.restore-prologue.XXXXXX")
SQL_FILE=$(mktemp "$WORK/.restore-sql.XXXXXX")
# The schema is dropped and recreated rather than relying on --clean, so tables
# that exist only in the database being replaced go too. Leftovers would make
# the next migration fail on "already exists".
printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n' >"$PROLOGUE"
# --no-owner / --no-privileges: every object belongs to the env's role,
# whatever role the source used (RDS's master user; the old box's sm_staging).
# --no-comments: COMMENT ON EXTENSION needs the extension's owner, and the
# schema carries no comments of its own. The rest name things this API does not
# use and a non-superuser could not restore anyway.
log "rendering the archive to SQL"
pg_restore --no-owner --no-privileges --no-comments --no-publications --no-subscriptions \
	--no-security-labels --no-tablespaces ${RESTORE_LIST:+-L "$RESTORE_LIST"} -f "$SQL_FILE" "$DUMP" ||
	die "pg_restore could not render the archive; nothing was changed"
log "restoring into $TARGET in one transaction"
STARTED=$(date +%s)
psql_target -q --single-transaction -f "$PROLOGUE" -f "$SQL_FILE" >/dev/null ||
	die "the restore failed and was rolled back; $TARGET is unchanged"
log "restore committed ($(($(date +%s) - STARTED))s)"
rm -f "$SQL_FILE"

# ---------------------------------------------------------------- 6 statistics + report
log "ANALYZE"
# The env's own role cannot analyze the shared catalogs (pg_authid, …) and
# Postgres says so once per catalog, a dozen WARNING lines that look like a
# failed restore. Its own tables are what the planner needs; mute the rest.
psql_target -q -c 'SET client_min_messages = error' -c 'ANALYZE' ||
	log "WARN: ANALYZE failed; autovacuum will analyze the tables on its own, later"
TABLES=$(sql "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
MIGRATIONS=$(sql "SELECT CASE WHEN to_regclass('public.migrations') IS NULL THEN 'no migrations table'
  ELSE (SELECT count(*)::text FROM public.migrations) || ' recorded, newest '
       || coalesce((SELECT name FROM public.migrations ORDER BY \"timestamp\" DESC LIMIT 1), '-') END")
BUILT=$(find "$CHECKOUT/dist/database/migrations" -maxdepth 1 -name '*.js' 2>/dev/null | wc -l | tr -d ' ')
log "restored $TARGET: $TABLES tables; migrations: $MIGRATIONS"
log "the checkout ($(git -C "$CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo '?')) ships $BUILT migration(s) in dist/"
if [ -n "$INTO" ]; then
	log "rehearsal restore done. Drop it when finished: sudo -u postgres dropdb $TARGET"
else
	log "Next: $SMS_ROOT/bin/sms-app.sh start $ENV_NAME (it was not started)"
fi
