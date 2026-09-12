# Deploying and undoing production

Production is released by dispatching **Deploy production**
(`.github/workflows/deploy-production.yml`). There is no push trigger: `main` is
an ordinary working branch here, so a push trigger would turn every merge into a
restart of the API that bills customers per message.

The same workflow is the rollback. `ref` accepts any branch, tag or SHA, so
undoing a release is dispatching it again against the SHA it replaced — printed
in the run summary, and appended on the box to `~/.sm-ops/RELEASES`.

## Releasing

```
Actions → Deploy production → Run workflow
  ref:     main            (or a SHA)
  confirm: deploy          (exact; anything else aborts before the suite runs)
  reason:  what and why
```

Order of operations, and why it is this order:

1. **guard** — refuses a wrong `confirm` and a ref containing anything but
   `[A-Za-z0-9._/-]`. Cheap, so it runs before the suite spends five minutes
   earning a deploy that was never going to happen. The charset check is also
   what makes forwarding the ref into a remote shell safe.
2. **test** — the *same* `ci.yml` staging gates on, not a lighter variant.
   Production is not held to a weaker bar than staging.
3. **checkpoint** — an RDS snapshot, waited on until `available`.
4. **deploy** — fetch, detached checkout, conditional `npm ci`, build, count
   pending migrations, migrate, `pm2 restart`.
5. **health** — polls `/health` for 45s.

## The checkpoint is an RDS snapshot, not a pg_dump

Deliberately. A dump taken on the box depends on the client version matching the
server's, and `pg_dump` 16.15 against a 17.9 instance has already produced a 4 KB
file here that looked like a backup and contained nothing. RDS takes the snapshot
itself, so there is no client to mismatch.

It is **waited for**, not fired and forgotten: a checkpoint whose creation was
never confirmed is indistinguishable from no checkpoint at the moment it matters.

Snapshots are named `sm-prod-predeploy-<run number>-<short sha>`.

## Undoing a release

Which path you take depends on one thing: **did the release run migrations?** The
run summary says so, under "Ran migrations".

### Code-only release (`migrated: false`)

Safe to revert freely, and the workflow does it for you: if `/health` fails and
no migration ran, it checks out the previous SHA, rebuilds, restarts, and
re-polls health. If you want to undo a *healthy* release, dispatch the workflow
with `ref` set to the replaced SHA.

### Schema-changing release (`migrated: true`)

**Not rolled back automatically, on purpose.** Reverting code across an applied
migration puts old code in front of a new schema — the one combination neither
version was ever tested against. The workflow stops and says so instead.

Two options, in order of preference:

1. **Roll forward.** Fix the defect, dispatch again. Almost always right: it
   keeps every row written since the release.
2. **Restore the snapshot**, then redeploy the previous SHA. This *loses every
   write since the snapshot was taken* — for this product that means OTP sends,
   wallet debits and top-ups. Treat it as the last resort, not the default.

```bash
# Restore into a NEW instance — never overwrite the live one in place.
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier sm-prod-restored-<date> \
  --db-snapshot-identifier sm-prod-predeploy-<run>-<sha>

# Then repoint DATABASE_HOST in ~/server/.env and restart:
pm2 restart startmessaging-server --update-env
```

Restoring to a new instance rather than in place keeps the damaged database
available for inspection, and makes the switch a one-line env change you can
reverse.

### Migrations are not all reversible

`migration:revert` exists but is not a general answer. At least one migration
refuses to run backwards on purpose — `1788000000000-DropLeadsPipeline` throws
from `down()`, because it dropped five tables and seven enums and no code can
conjure the rows back. Read the migration before assuming a revert is available.

## Required secrets

The staging workflow's `STAGING_*` secrets already reach this box — production
shares the EC2 host with staging — but production gets its **own** names, with no
fallback to the staging ones. A fallback would hide a misconfiguration, and this
repo has already lost months of telemetry to exactly that (a workflow reading
`vars.STAGING_POSTHOG_KEY` into a build that wanted `VITE_POSTHOG_KEY`, where an
unset variable expands to an empty string and nothing fails).

| Secret | Value |
|---|---|
| `PRODUCTION_HOST` | same as `STAGING_HOST` (one box) |
| `PRODUCTION_USER` | same as `STAGING_USER` |
| `PRODUCTION_SSH_KEY` | same as `STAGING_SSH_KEY` |
| `PRODUCTION_API_URL` | `https://api.startmessaging.com` |
| `PRODUCTION_RDS_INSTANCE_ID` | the RDS DB instance identifier |
| `AWS_ACCESS_KEY_ID` | IAM user, snapshot permissions only |
| `AWS_SECRET_ACCESS_KEY` | — |
| `AWS_REGION` | the RDS instance's region |

The IAM user needs three actions and nothing else:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "rds:CreateDBSnapshot",
      "rds:DescribeDBSnapshots",
      "rds:DescribeDBInstances"
    ],
    "Resource": "*"
  }]
}
```

Restoring is deliberately **not** in that policy. A restore is a decision a human
makes with the runbook open, not something a workflow should be able to do.

## What this pipeline still does not do

- **No blue/green.** `pm2 restart` drops in-flight requests. The box has 2 GB of
  RAM and already runs staging beside production, so a second copy of the app
  does not fit. Accepted, not overlooked.
- **No automatic snapshot pruning.** Snapshots accumulate and cost money. Delete
  old `sm-prod-predeploy-*` ones periodically.
- **The front-ends are not in here.** `admin-panel` and `dashboard` are
  Cloudflare Workers; production is `npx wrangler deploy` from a build carrying
  the production env. Never `npm run deploy` — it rebuilds from `.env`, which
  points at localhost.
