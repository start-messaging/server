#!/usr/bin/env bash
#
# Seeds the E2E database with a demo affiliate scenario for manual and browser
# testing. Not used by the Playwright API suite — that builds its own fixtures
# per test and truncates between them, which is why anything seeded here
# disappears the moment the suite runs.
#
# Creates:
#   - an admin (boss@example.com)
#   - a partner WITH a payout destination, holding a settled pending payout
#   - a partner WITHOUT one, plus a legacy payout row that has no destination
#     recorded — the case the "Mark paid" guard exists for
#
# Usage:  ./scripts/seed-demo.sh          (expects the API running on $API)
set -euo pipefail

cd "$(dirname "$0")/.."

API=${API:-http://127.0.0.1:3010}
PASS=${DEMO_PASSWORD:-Password123!}

DB=$(grep '^DATABASE_NAME=' .env.e2e | cut -d= -f2-)
export PGPASSWORD=$(grep '^DATABASE_PASSWORD=' .env.e2e | cut -d= -f2-)
PSQL=(psql -h 127.0.0.1 -U postgres -d "$DB" -tAq)

# Refuse to touch anything that is not obviously a test database — the dev
# database on this machine holds a restore of production.
case "$DB" in
  *e2e*|*test*) ;;
  *) echo "Refusing to seed non-test database '$DB'" >&2; exit 1 ;;
esac

echo "Seeding $DB via $API"

"${PSQL[@]}" -c "TRUNCATE partner_commissions, partner_payouts, referral_clicks,
  referrals, partners, messages, wallet_transactions, payments, wallets,
  api_keys, users RESTART IDENTITY CASCADE;" >/dev/null

json() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data']$1)"; }

# ── admin ──────────────────────────────────────────────
curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"boss@example.com\",\"password\":\"$PASS\",\"firstName\":\"Ada\",\"lastName\":\"Admin\"}" >/dev/null
"${PSQL[@]}" -c "UPDATE users SET role='admin' WHERE email='boss@example.com';" >/dev/null

ADMIN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"boss@example.com\",\"password\":\"$PASS\"}" | json "['accessToken']")

curl -sS -X PATCH "$API/admin/affiliate/settings" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN" \
  -d '{"isEnabled":true,"minPaidReferrals":1,"minPayoutAmount":10,
       "defaultCommissionType":"percent","defaultCommissionRate":10}' >/dev/null

# ── partners ───────────────────────────────────────────
seed_partner() {           # $1 = handle, $2 = give a payout destination?
  local handle=$1 withDest=$2
  curl -sS -X POST "$API/partner/auth/register" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$handle@partner.com\",\"password\":\"$PASS\",\"firstName\":\"Demo\",\"lastName\":\"Partner\"}" >/dev/null

  if [ "$withDest" = yes ]; then
    "${PSQL[@]}" -c "UPDATE partners SET status='active', \"payoutMethod\"='upi',
      \"upiId\"='$handle@okhdfc' WHERE email='$handle@partner.com';" >/dev/null
  else
    "${PSQL[@]}" -c "UPDATE partners SET status='active' WHERE email='$handle@partner.com';" >/dev/null
  fi

  local pid code uid
  pid=$("${PSQL[@]}" -c "SELECT id FROM partners WHERE email='$handle@partner.com';")
  code=$("${PSQL[@]}" -c "SELECT \"referralCode\" FROM partners WHERE email='$handle@partner.com';")

  "${PSQL[@]}" -c "INSERT INTO users (email,\"firstName\",\"lastName\",role)
    VALUES ('c_$handle@example.com','Referred','Customer','customer');" >/dev/null
  uid=$("${PSQL[@]}" -c "SELECT id FROM users WHERE email='c_$handle@example.com';")

  "${PSQL[@]}" -c "INSERT INTO referrals (\"partnerId\",\"userId\",\"referralCode\",status,\"qualifiedAt\")
    VALUES ('$pid','$uid','$code','qualified',now());" >/dev/null
  "${PSQL[@]}" -c "INSERT INTO messages (\"userId\",\"phoneNumber\",content,provider,status,\"costAmount\",\"deliveredAt\")
    VALUES ('$uid','+919000000000','OTP 123456','console','delivered',500,now());" >/dev/null

  echo "$pid"
}

seed_partner good yes >/dev/null
NODEST_ID=$(seed_partner nodest no)

curl -sS -X POST "$API/admin/affiliate/jobs/accrual"  -H "Authorization: Bearer $ADMIN" >/dev/null
curl -sS -X POST "$API/admin/affiliate/jobs/payouts"  -H "Authorization: Bearer $ADMIN" >/dev/null

# The payout run now refuses to raise one for a partner with no destination, so
# this row is inserted directly — it stands in for payouts raised before that
# guard existed, which is exactly what the "Mark paid" guard has to handle.
"${PSQL[@]}" -c "INSERT INTO partner_payouts (\"partnerId\",\"periodKey\",\"periodStart\",\"periodEnd\",
  amount,\"commissionCount\",\"qualifiedReferralCount\",status)
  VALUES ('$NODEST_ID','2026-07','2026-07-01','2026-07-31',50,1,1,'pending');" >/dev/null

echo
echo "admin    boss@example.com / $PASS"
echo "partner  good@partner.com / $PASS   (has a payout destination)"
echo "partner  nodest@partner.com / $PASS (no destination; legacy payout row)"
echo
echo "ADMIN_TOKEN=$ADMIN"
echo
"${PSQL[@]}" -c "SELECT p.email, po.\"periodKey\", po.status, po.amount,
  COALESCE(po.\"payoutMethod\"::text,'(none)') AS destination
  FROM partner_payouts po JOIN partners p ON p.id=po.\"partnerId\" ORDER BY p.email;"
