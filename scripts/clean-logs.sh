#!/usr/bin/env bash
#
# Reclaims disk on the deployment box by deleting logs older than a retention
# window.
#
# Written after 2026-08-07, when the box filled to 100% and the API silently
# stopped writing logs for fifteen hours while continuing to serve traffic.
# Nothing alerted, because the thing that would have told us was the log.
#
# Only rotated logs are deleted. Active files — the ones pm2 currently holds
# open, like startmessaging-server-out.log — are matched by neither pattern
# below, so a mistake here cannot truncate a live log or wedge the writer.
#
# The box also hosts unrelated apps (my-app, ourDesignFrontend). This script
# deliberately touches only the pm2 apps named in PM2_APPS, so an automated run
# can never delete another project's logs. Widen it by passing PM2_APPS.
#
# Usage:
#   ./scripts/clean-logs.sh                # 30-day retention (default)
#   ./scripts/clean-logs.sh 7              # keep 7 days
#   RETENTION_DAYS=90 ./scripts/clean-logs.sh
#   DRY_RUN=1 ./scripts/clean-logs.sh      # list what would go, delete nothing
#   PM2_APPS="startmessaging-server" ./scripts/clean-logs.sh
#
# Runs unprivileged. The journald step needs sudo and is skipped without it,
# so the script is still useful when run by a plain deploy user.
set -euo pipefail

RETENTION_DAYS="${1:-${RETENTION_DAYS:-30}}"
DRY_RUN="${DRY_RUN:-0}"
PM2_LOG_DIR="${PM2_LOG_DIR:-$HOME/.pm2/logs}"
PM2_APPS="${PM2_APPS:-startmessaging-server startmessaging-staging}"

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [ "$RETENTION_DAYS" -lt 1 ]; then
  echo "Retention must be a positive whole number of days, got '$RETENTION_DAYS'" >&2
  exit 1
fi

if [ "$DRY_RUN" != "0" ]; then
  echo "DRY RUN — nothing will be deleted"
fi
echo "Retention: ${RETENTION_DAYS} days"
echo "Apps:      ${PM2_APPS}"
echo

avail_kb() { df -Pk / | awk 'NR==2 {print $4}'; }
before=$(avail_kb)

# pm2 writes rotated logs as <name>__YYYY-MM-DD_HH-mm-ss.log, optionally
# gzipped. Anchoring on that suffix is what keeps active logs out of scope.
if [ -d "$PM2_LOG_DIR" ]; then
  echo "== pm2 rotated logs in $PM2_LOG_DIR"
  # One -name clause per app, OR'd together, so nothing outside PM2_APPS is
  # ever a candidate. Built as an array rather than a glob string because an
  # unquoted pattern would expand against the cwd before find ever sees it.
  name_args=()
  for app in $PM2_APPS; do
    for suffix in 'log' 'log.gz'; do
      [ "${#name_args[@]}" -gt 0 ] && name_args+=(-o)
      name_args+=(-name "${app}-*__????-??-??_??-??-??.${suffix}")
    done
  done

  mapfile -t stale < <(
    find "$PM2_LOG_DIR" -maxdepth 1 -type f \
      \( "${name_args[@]}" \) \
      -mtime "+${RETENTION_DAYS}" -print | sort
  )
  if [ "${#stale[@]}" -eq 0 ]; then
    echo "   nothing older than ${RETENTION_DAYS} days"
  else
    for f in "${stale[@]}"; do
      echo "   $(du -h "$f" | cut -f1)	$(basename "$f")"
      [ "$DRY_RUN" = "0" ] && rm -f "$f"
    done
    echo "   ${#stale[@]} file(s)"
  fi
else
  echo "== pm2 log dir $PM2_LOG_DIR not found — skipped"
fi
echo

# journald honours the same window natively, so retention stays in one place.
echo "== systemd journal"
if command -v journalctl >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  if [ "$DRY_RUN" = "0" ]; then
    sudo journalctl --vacuum-time="${RETENTION_DAYS}d" 2>&1 | tail -1
  else
    echo "   would run: journalctl --vacuum-time=${RETENTION_DAYS}d"
  fi
else
  echo "   skipped (needs passwordless sudo)"
fi
echo

# Downloaded .deb archives are re-fetchable and were 300MB of the outage.
echo "== apt package cache"
if command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  if [ "$DRY_RUN" = "0" ]; then
    sudo apt-get clean
    echo "   cleared"
  else
    echo "   would run: apt-get clean"
  fi
else
  echo "   skipped (needs passwordless sudo)"
fi
echo

after=$(avail_kb)
freed=$(( after - before ))
echo "Free space: $(( before / 1024 ))MB -> $(( after / 1024 ))MB (freed $(( freed / 1024 ))MB)"
df -h / | tail -1
