#!/usr/bin/env bash
# deploy/backup-db.sh <production|staging> [label]
#
# pg_dump -Fc of one environment's database, taken ON the StartMessaging EC2
# box, the box where this API's Postgres runs locally (see
# whatsapp-server/docs/DEPLOYMENT.md, "The SMS API on this box"). Run as the
# deploy user. Callers:
#
#   - .github/workflows/deploy-production.yml, before every release, when the
#     PRODUCTION_RDS_INSTANCE_ID secret is NOT set. While production's database
#     is RDS that secret is set and the checkpoint is an RDS snapshot instead.
#   - .github/workflows/deploy-staging.yml, before every release, on a box
#     that has /srv/sms/staging/backups (the old box has no such layout, and
#     deploys staging exactly as it always did).
#     Both workflows stream THIS file over ssh from their own checkout, so the
#     script always matches the workflow calling it. Keep it self-contained:
#     it sources nothing.
#   - sms-backup@<env>.timer, nightly, from the copy the box bootstrap installs
#     at /srv/sms/bin/backup-db.sh.
#   - deploy/restore-db.sh, for a safety dump before it overwrites a database.
#   - a person: /srv/sms/bin/backup-db.sh production manual
#
# The database is the one the env's own .env names (~/server/.env,
# ~/server-staging/.env): exactly what the app talks to. The dump lands in
#
#   /srv/sms/<env>/backups/sms-<env>-<UTC time>-<label>-<sha7>.dump
#
# where <sha7> is the commit that env's checkout is on: the release whose
# schema the dump holds, which is what you need to know when restoring it. The
# newest BACKUP_KEEP_LOCAL (default 7) are kept. When /srv/sms/shared/backup.env
# names a bucket (AWS S3 through the instance role, or R2 with a key pair) the
# dump is also uploaded to
#
#   s3://<BACKUP_S3_BUCKET>/sms/<env>/YYYY/MM/DD/<the same file name>
#
# and that prefix is pruned to 30 days of everything plus the newest dump of
# each of the last 12 months.
#
# What it refuses to call a backup:
#   - anything written by a pg_dump older than the server. pg_dump 16.15 run
#     against the RDS 17.9 instance has already left a 4 KB file here that
#     looked like a backup and held nothing (PRODUCTION-DEPLOY.md). The majors
#     are compared before anything is written.
#   - a dump that pg_restore cannot list, or that lacks a TABLE DATA entry for
#     any table the database has.
# And it will not fill the disk Postgres lives on: it needs the database's size
# plus 1 GiB free first.
#
# Output: progress on stderr. The dump's path is the ONLY line on stdout, and
# stdout is empty when the database has no tables yet (nothing to back up).
# Exit: 0 dump verified (and uploaded, if a bucket is named) or nothing to back
# up; 3 dump verified on the box, but its bucket copy failed; 1 no usable dump;
# 64 usage.
set -Eeuo pipefail
umask 077

SMS_ROOT="${SMS_ROOT:-/srv/sms}"

exec 3>&1 1>&2
log() { printf '%s [sms-backup %s] %s\n' "$(date -u +%FT%TZ)" "${ENV_NAME:-?}" "$*"; }
warn() { log "WARN: $*"; }
die() {
	log "ERROR: $*"
	exit 1
}
usage() {
	echo "usage: $(basename "$0") <production|staging> [label]"
	exit 64
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
ENV_NAME=$1
LABEL=${2:-manual}
case "$ENV_NAME" in production | staging) ;; *) usage ;; esac
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,60}$ ]] || die "label must match [A-Za-z0-9._-]{1,60}"
[ "$(id -u)" -ne 0 ] || die "run as the deploy user, not root: the dumps belong to it"

# Reads one KEY from a dotenv file without executing it. The same reader as
# whatsapp-server's deploy tooling; duplicated because this file must stand alone.
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
WORK="$SMS_ROOT/$ENV_NAME/backups"
BACKUP_ENV="$SMS_ROOT/shared/backup.env"

if [ ! -d "$WORK" ] || [ ! -w "$WORK" ]; then
	die "$WORK is missing or not writable: this is not the EC2 box's layout (whatsapp-server's deploy/bootstrap.sh creates it)"
fi
[ -r "$APP_ENV" ] || die "missing $APP_ENV"

DB_HOST=$(env_get "$APP_ENV" DATABASE_HOST) || die "DATABASE_HOST not set in $APP_ENV"
DB_PORT=$(env_get "$APP_ENV" DATABASE_PORT) || DB_PORT=5432
DB_NAME=$(env_get "$APP_ENV" DATABASE_NAME) || die "DATABASE_NAME not set in $APP_ENV"
DB_USER=$(env_get "$APP_ENV" DATABASE_USERNAME) || die "DATABASE_USERNAME not set in $APP_ENV"
DB_PASS=$(env_get "$APP_ENV" DATABASE_PASSWORD) || die "DATABASE_PASSWORD not set in $APP_ENV"
DB_SSL=$(env_get "$APP_ENV" DATABASE_SSL) || DB_SSL=""
# The app's own rule, minus the NODE_ENV fallback: an unset DATABASE_SSL lets
# libpq negotiate (prefer), which works wherever the app works.
case "${DB_SSL,,}" in true) SSLMODE=require ;; false) SSLMODE=disable ;; *) SSLMODE=prefer ;; esac

# Connection details reach libpq through its environment, in a subshell, never
# through argv (world-readable in /proc).
pg() {
	(
		export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGDATABASE="$DB_NAME" PGUSER="$DB_USER" \
			PGPASSWORD="$DB_PASS" PGSSLMODE="$SSLMODE" PGCONNECT_TIMEOUT=15
		"$@"
	)
}
sql() { pg psql -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# One dump per env at a time. A nightly run that meets a deploy's dump waits
# for it instead of doubling the disk and I/O. restore-db.sh, which already
# holds this lock when it asks for a safety dump, says so with
# SMS_BACKUP_LOCK_HELD=1.
if [ "${SMS_BACKUP_LOCK_HELD:-}" != 1 ]; then
	exec 9>"$SMS_ROOT/$ENV_NAME/.backup.lock"
	flock -w 1800 9 || die "another dump of $ENV_NAME has held $SMS_ROOT/$ENV_NAME/.backup.lock for 30 min"
fi

SERVER_NUM=$(sql 'SHOW server_version_num') || die "cannot reach $DB_NAME on $DB_HOST:$DB_PORT as $DB_USER"
SERVER_MAJOR=$((SERVER_NUM / 10000))
CLIENT=$(pg_dump --version | awk '{ print $3 }')
CLIENT_MAJOR=${CLIENT%%.*}
[[ "$CLIENT_MAJOR" =~ ^[0-9]+$ ]] || die "cannot read pg_dump's version ('$CLIENT')"
[ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] ||
	die "pg_dump $CLIENT is older than the server ($SERVER_MAJOR); its dump would not be a backup. Install postgresql-client-$SERVER_MAJOR."

# Tables pg_dump will emit data for: ordinary tables outside the system
# schemas, minus extension-owned ones (pg_dump skips those too).
TABLES=$(sql "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')")
if [ "$TABLES" -eq 0 ]; then
	log "$DB_NAME has no tables yet (not restored or migrated on this box): nothing to back up"
	exit 0
fi

DB_BYTES=$(sql 'SELECT pg_database_size(current_database())')
AVAIL=$(df -B1 --output=avail "$WORK" | tail -n 1 | tr -d ' ')
[ "$AVAIL" -gt $((DB_BYTES + 1073741824)) ] ||
	die "only $AVAIL bytes free in $WORK for a $DB_BYTES-byte database; refusing to fill the disk Postgres lives on"

SHA=$(git -C "$CHECKOUT" rev-parse --short=7 HEAD 2>/dev/null) || SHA=nogit
TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="sms-$ENV_NAME-$TS-$LABEL-$SHA.dump"
FILE="$WORK/$NAME"
PARTIAL="$FILE.partial"
trap 'rm -f "$PARTIAL"' EXIT

log "dumping $DB_NAME ($DB_BYTES bytes, $TABLES tables, server $SERVER_NUM) with pg_dump $CLIENT"
STARTED=$(date +%s)
pg pg_dump -Fc --no-password -f "$PARTIAL" || die "pg_dump failed; nothing was kept"
LIST=$(pg_restore --list "$PARTIAL") || die "the dump does not read back with pg_restore --list"
ENTRIES=$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' <<<"$LIST" || true)
[ "$ENTRIES" -ge "$TABLES" ] ||
	die "the dump lists $ENTRIES TABLE DATA entries for $TABLES tables; refusing to call it a backup"
mv -f "$PARTIAL" "$FILE"
trap - EXIT
SIZE=$(stat -c %s "$FILE")
log "dump verified: $NAME ($SIZE bytes, $ENTRIES tables, $(($(date +%s) - STARTED))s)"

# Local retention: the newest N of this script's own dumps. Files named
# otherwise (a cutover dump, a copy someone parked here) are never touched.
KEEP_LOCAL=""
[ -r "$BACKUP_ENV" ] && KEEP_LOCAL=$(env_get "$BACKUP_ENV" BACKUP_KEEP_LOCAL || true)
[[ "$KEEP_LOCAL" =~ ^[1-9][0-9]*$ ]] || KEEP_LOCAL=7
find "$WORK" -maxdepth 1 -type f -name "sms-$ENV_NAME-*.dump" -printf '%T@ %p\n' |
	sort -rn | tail -n +$((KEEP_LOCAL + 1)) | cut -d' ' -f2- |
	while IFS= read -r old; do
		log "pruning local $(basename "$old")"
		rm -f -- "$old"
	done

# ------------------------------------------------------ off-box copy (optional)
UPLOAD_RC=0
BUCKET="" ENDPOINT="" REGION="" PING_URL="" KEY_ID="" SECRET=""
S3_ARGS=()
if [ -r "$BACKUP_ENV" ]; then
	BUCKET=$(env_get "$BACKUP_ENV" BACKUP_S3_BUCKET || true)
	ENDPOINT=$(env_get "$BACKUP_ENV" BACKUP_S3_ENDPOINT || true)
	REGION=$(env_get "$BACKUP_ENV" BACKUP_S3_REGION || true)
	KEY_ID=$(env_get "$BACKUP_ENV" BACKUP_S3_ACCESS_KEY_ID || true)
	SECRET=$(env_get "$BACKUP_ENV" BACKUP_S3_SECRET_ACCESS_KEY || true)
	PING_URL=$(env_get "$BACKUP_ENV" "BACKUP_PING_URL_${ENV_NAME^^}" || true)
fi
ping_monitor() {
	[ -n "$PING_URL" ] || return 0
	curl -fsS -m 10 --retry 3 -o /dev/null "$PING_URL$1" || warn "could not reach the backup monitor"
}

# Readies the aws CLI for the bucket, the same two kinds as whatsapp-server's
# backup_s3_setup (scripts/deploy/lib.sh). Exports only what the aws CLI reads;
# nothing here starts the app.
s3_setup() {
	# Whatever the calling shell carried, only backup.env decides which
	# identity the CLI uses.
	unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
	if [ -n "$ENDPOINT" ]; then
		# An S3-compatible store elsewhere, e.g. Cloudflare R2, with a key pair
		# scoped to the backup bucket. R2 ignores the region ("auto" is what
		# Cloudflare documents), and the checksum settings stop aws CLI v2's
		# default CRC trailers, which R2 has rejected on some operations.
		if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then
			warn "BACKUP_S3_ENDPOINT is set in $BACKUP_ENV but its key pair is not"
			return 1
		fi
		export AWS_ACCESS_KEY_ID=$KEY_ID AWS_SECRET_ACCESS_KEY=$SECRET AWS_DEFAULT_REGION=${REGION:-auto}
		export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
		S3_ARGS=(--endpoint-url "$ENDPOINT")
	else
		# AWS S3 itself: no keys. The aws CLI takes the instance role's
		# short-lived credentials from the metadata service; the role may
		# write, read and prune the bucket but never erase old versions.
		# Keys here would send R2 credentials to AWS, or put a long-lived AWS
		# key on a box whose role already has the access.
		if [ -n "$KEY_ID$SECRET" ]; then
			warn "$BACKUP_ENV has an access key but no BACKUP_S3_ENDPOINT; AWS S3 is reached through the instance role, so remove the keys"
			return 1
		fi
		export AWS_DEFAULT_REGION=${REGION:-ap-south-1}
		S3_ARGS=()
	fi
	AWS_CLI=$(command -v aws || true)
	if [ -z "$AWS_CLI" ] && [ -x /snap/bin/aws ]; then AWS_CLI=/snap/bin/aws; fi
	if [ -z "$AWS_CLI" ]; then
		warn "aws CLI not found"
		return 1
	fi
}
s3() { "$AWS_CLI" "${S3_ARGS[@]}" "$@"; }

upload() {
	local key remote_size keep_daily keep_monthly
	s3_setup || return 1
	key="sms/$ENV_NAME/$(date -u +%Y/%m/%d)/$NAME"
	log "uploading to s3://$BUCKET/$key"
	s3 s3 cp "$FILE" "s3://$BUCKET/$key" --only-show-errors || return 1
	remote_size=$(s3 s3api head-object --bucket "$BUCKET" --key "$key" \
		--query ContentLength --output text) || return 1
	[ "$remote_size" = "$SIZE" ] || {
		warn "uploaded object is $remote_size bytes, the dump is $SIZE"
		return 1
	}
	keep_daily=$(env_get "$BACKUP_ENV" BACKUP_KEEP_DAILY_DAYS || echo 30)
	keep_monthly=$(env_get "$BACKUP_ENV" BACKUP_KEEP_MONTHLY || echo 12)
	LC_ALL=C prune_remote "$keep_daily" "$keep_monthly" || warn "pruning old bucket dumps failed; the new one is safe"
	log "uploaded: s3://$BUCKET/$key"
}

# Everything from the last <days> days, plus the newest dump of each of the
# <months> most recent months. Only keys in this script's naming scheme, under
# this env's own prefix, are ever candidates.
prune_remote() {
	local days=$1 months=$2 listing cutoff key day month re keep=""
	local -A newest=()
	local -a candidates=()
	listing=$(s3 s3api list-objects-v2 --bucket "$BUCKET" \
		--prefix "sms/$ENV_NAME/" --output json | jq -r '.Contents[]?.Key')
	cutoff=$(date -u -d "-$days days" +%Y%m%d)
	re="^sms/${ENV_NAME}/([0-9]{4})/([0-9]{2})/([0-9]{2})/sms-${ENV_NAME}-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+\.dump$"
	while IFS= read -r key; do
		[[ "$key" =~ $re ]] || continue
		day="${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
		month="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
		if [[ -z "${newest[$month]:-}" || "$key" > "${newest[$month]}" ]]; then newest[$month]=$key; fi
		[ "$day" -ge "$cutoff" ] || candidates+=("$key")
	done <<<"$listing"
	while IFS= read -r month; do
		[ -n "$month" ] && keep+="${newest[$month]}"$'\n'
	done < <(printf '%s\n' "${!newest[@]}" | sort -r | head -n "$months")
	for key in "${candidates[@]}"; do
		grep -qxF "$key" <<<"$keep" && continue
		log "pruning s3://$BUCKET/$key"
		s3 s3 rm "s3://$BUCKET/$key" --only-show-errors
	done
}

if [ -n "$BUCKET" ]; then
	upload || UPLOAD_RC=3
	[ "$UPLOAD_RC" = 0 ] || warn "the bucket copy failed: the dump is on this box only ($FILE)"
else
	log "no backup bucket in $BACKUP_ENV: the dump stays on this box only"
fi

if [ "$UPLOAD_RC" = 0 ]; then ping_monitor ""; else ping_monitor /fail; fi
log "backup complete: $FILE"
echo "$FILE" >&3
exit "$UPLOAD_RC"
