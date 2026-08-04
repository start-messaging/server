# Staging

A full copy of the system that shares a box with production and shares
nothing else. It exists so that a change can be run against production-shaped
data before it reaches production.

| | Production | Staging |
|---|---|---|
| API | `api.startmessaging.com` → `:5000` | `api-staging.3-110-128-86.nip.io` → `:5001` |
| pm2 process | `startmessaging-server` | `startmessaging-staging` |
| Directory | `~/server` | `~/server-staging` |
| Branch | `main` | `staging` |
| Database | `postgres` on RDS | `startmessaging_staging` on the same RDS instance |
| Redis | Redis Cloud | `redis://127.0.0.1:6379` on the box, prefix `staging:` |
| SMS | live providers | `MOCK_SMS_SEND=true` — nothing is ever sent |
| Payments | live Razorpay keys | none configured |

## What staging deliberately cannot do

The staging database began as a restore of production, which means **the user
IDs are the same as production's**. That fact drives most of what follows.

- **No Razorpay keys.** Production runs `rzp_live_…`. Any staging checkout on
  those keys would move real money, so staging has none and the payment flow
  returns an error until someone adds `rzp_test_…` keys.
- **No SMS provider keys, and `MOCK_SMS_SEND=true`.** Two independent reasons
  a staging message cannot reach a handset.
- **No Mailgun key.** Every staging address was rewritten to
  `@staging.invalid`, but a missing key means no send is even attempted.
- **No R2 credentials.** Uploads are keyed by user ID, and staging's user IDs
  are production's, so a shared bucket would let a staging KYC upload
  overwrite a real customer's document.
- **No PostHog key**, so staging traffic does not distort production analytics.
- **Its own JWT secrets.** A token minted on staging is refused by production
  and vice versa.

The data itself was scrubbed before any of this ran: password hashes, refresh
tokens, OTP hashes and API key hashes were destroyed, email addresses became
`@staging.invalid`, and every phone number became `+9199999xxxxx`, which
cannot route to a real handset.

## Redis

Production's Redis is a Redis Cloud instance with **one** logical database —
`SELECT 1` answers "DB index is out of range" — and an eviction policy of
`volatile-lru`. So staging could not simply take a different database number,
and pointing staging at it would have meant two environments sharing a
keyspace: staging workers would have pulled real jobs off the `messages`
queue, which is the queue that spends money.

Staging therefore runs its own Redis on the box, bound to loopback, capped at
192 MB, with `maxmemory-policy noeviction` — the policy BullMQ asks for and
production's Redis does not have.

`REDIS_KEY_PREFIX` namespaces all three consumers (BullMQ, the rate limiter,
and the shared client) as a second line of defence. It is empty in production,
where every code path is exactly the one that ran before it existed.

## Deploying

Push to `staging`. The workflow runs the test suite, then builds on the box,
runs migrations, restarts pm2, and polls `/health` — failing the run and
printing logs if it does not come back.

Migrations run *before* the restart, so new code never meets an old schema,
and they are transactional, so a failed migration leaves the previous release
serving.

## Restoring production

Snapshots are listed in `~/.sm-ops/LATEST_SNAPSHOT`. The restore path has been
exercised, not assumed: a snapshot was restored to a scratch database and its
row counts matched production exactly.

## Still to be connected

The front-ends are the one part not finished, and the reason is access rather
than code.

- **The local wrangler is logged into the wrong Cloudflare account.** It
  authenticates as `geetaapppublications@gmail.com`, account
  `16a0f9b007c4ba730d926a11e709e7a3`. That account does **not** contain the
  `startmessaging.com` zone (a zone lookup returns nothing) and does **not**
  contain the production `dashboard`, `admin-panel` or `partners` Workers —
  all three return 404. What it does contain is the unrelated `mathe*`
  Workers. Production is therefore served from a different account that this
  machine has no credentials for.
- **Consequence:** `stage-app`, `stage-admin` and `stage-partners` records
  cannot be created from here, and the staging Workers uploaded so far
  (`dashboard-staging`, `admin-panel-staging`) went into that wrong account,
  where they are unreachable and can be deleted. `partners-staging` never
  uploaded at all.
- **What unblocks it:** `wrangler login` against the account that owns
  `startmessaging.com`, or an API token for that account with
  Workers Scripts:Edit, Workers Routes:Edit and Zone:DNS:Edit. The same token
  becomes the `CLOUDFLARE_API_TOKEN` secret the deploy workflows need — the
  one CI secret still unset, because the local wrangler uses OAuth and CI
  cannot.
- **A real API hostname.** `nip.io` resolves to the box's IP with no DNS
  record at all, which is why staging works today with a valid certificate.
  Once there is DNS access, `stage-api.startmessaging.com` pointed at
  `3.110.128.86` plus `certbot --nginx -d stage-api.startmessaging.com` is a
  two-minute change; only `STAGING_API_URL` and the front-end builds refer to
  the old name.
