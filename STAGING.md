# Staging

A full copy of the system that shares a box with production and shares
nothing else. It exists so that a change can be run against production-shaped
data before it reaches production.

| | Production | Staging |
|---|---|---|
| API | `api.startmessaging.com` → `:5000` | `stage-api.startmessaging.com` → `:5001` |
| pm2 process | `startmessaging-server` | `startmessaging-staging` |
| Directory | `~/server` | `~/server-staging` |
| Branch | `main` | `staging` |
| Dashboard | `app.startmessaging.com` | `stage-app.startmessaging.com` |
| Admin | `admin.startmessaging.com` | `stage-admin.startmessaging.com` |
| Partners | *not deployed* | `stage-partners.startmessaging.com` |
| Database | `postgres` on RDS | `startmessaging_staging` on the same RDS instance |
| Redis | Redis Cloud | `redis://127.0.0.1:6379` on the box, prefix `staging:` |
| SMS | live providers | `MOCK_SMS_SEND=true` — nothing is ever sent |
| Payments | Razorpay `rzp_live_…` | Razorpay `rzp_test_…` |

## What staging deliberately cannot do

The staging database began as a restore of production, which means **the user
IDs are the same as production's**. That fact drives most of what follows.

- **Razorpay test keys only.** Production runs `rzp_live_…`; staging runs
  `rzp_test_…`, a different account mode, so a checkout here cannot move real
  money no matter what the client sends. There is no
  `RAZORPAY_WEBHOOK_SECRET`, so gateway webhooks are the one payment path
  staging cannot exercise.
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

## Cloudflare

Everything lives in the account that owns the zone,
`Startmessagingdotcom@gmail.com's Account`
(`6f25299ceeb0e04e343afd7f32abb715`), zone `startmessaging.com`.

Worth knowing, because it cost an afternoon: the `wrangler` login on the
development machine authenticates a *different* account
(`geetaapppublications@gmail.com`), which holds the unrelated `mathe`
Workers and does not contain this zone at all. A `wrangler deploy` from
there uploads successfully and then fails only at the routing step, which
reads like a permissions problem on the right account rather than success
against the wrong one. CI does not have this hazard: it authenticates with
`CLOUDFLARE_API_TOKEN`, which is scoped to the correct account.

The three staging front-ends are Workers with Custom Domains attached:

| Hostname | Worker |
|---|---|
| `stage-app.startmessaging.com` | `dashboard-staging` |
| `stage-admin.startmessaging.com` | `admin-panel-staging` |
| `stage-partners.startmessaging.com` | `partners-staging` |

`stage-api` is a plain unproxied `A` record to the EC2 box, matching
`api.startmessaging.com` — the origin terminates its own TLS via certbot, so
putting Cloudflare in front of it would add a second, pointless hop.

The production `partners` Worker does not exist. The partner portal has only
ever been deployed to staging.

## The one guard worth explaining

The front-end deploys refuse to ship a bundle that references the production
API. That check is anchored on the scheme — `https://api.startmessaging.com`
— because `stage-api.startmessaging.com` *contains* `api.startmessaging.com`
as a substring, and the naive pattern matched every staging bundle. It now
also asserts the staging URL *is* present, so a build where the environment
silently failed to apply is caught rather than deployed.
