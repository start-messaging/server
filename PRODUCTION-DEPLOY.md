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
3. **checkpoint** — an RDS snapshot, waited on until `available`, while
   production's database is RDS; an on-box `pg_dump` once production runs on
   the EC2 box with its own Postgres (below).
4. **deploy** — fetch, detached checkout, conditional `npm ci`, build, count
   pending migrations, migrate, `pm2 restart`.
5. **health** — polls `/health` for 45s.

## The checkpoint: an RDS snapshot on RDS, a verified dump on the EC2 box

One secret decides which, so the same workflow serves both worlds and the old
box keeps releasing exactly as before until the secrets are switched:

| `PRODUCTION_RDS_INSTANCE_ID` | Checkpoint |
|---|---|
| set (production's database is RDS) | an RDS snapshot, `sm-prod-predeploy-<run number>-<short sha>` |
| not set (production runs on the EC2 box, Postgres local) | `deploy/backup-db.sh production pre-deploy-run<N>`, run ON the box: `/srv/sms/production/backups/sms-production-<UTC>-pre-deploy-run<N>-<sha7 of the release it replaces>.dump`, also copied to the backup bucket when `/srv/sms/shared/backup.env` names one |

**On RDS, a snapshot rather than a dump, deliberately.** A dump taken on the old
box depends on the client version matching the server's, and `pg_dump` 16.15
against a 17.9 instance has already produced a 4 KB file here that looked like a
backup and contained nothing. RDS takes the snapshot itself, so there is no
client to mismatch.

**On the EC2 box, a dump, with that failure designed out.** The database is
local and the box's `pg_dump` is the server's own major. `backup-db.sh` still
compares the two majors before writing anything, refuses an archive that
`pg_restore` cannot list or that lacks a `TABLE DATA` entry for any table,
refuses to start without the database's size plus 1 GiB free (a full disk takes
Postgres down for every database on the box), and refuses outright where
production's database has no tables (that box is not production yet). The
workflow streams the script from its own checkout, so the box runs the version
the workflow was written against. Exit 3 means the dump is on the box but its
bucket copy failed: the release goes ahead with a warning, because the local file is
what undoes a migration.

Either way it is **waited for**, not fired and forgotten: a checkpoint whose
creation was never confirmed is indistinguishable from no checkpoint at the
moment it matters.

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
2. **Restore the checkpoint**, then redeploy the previous SHA. This *loses
   every write since the checkpoint was taken* — for this product that means
   OTP sends, wallet debits and top-ups. Treat it as the last resort, not the
   default.

On the EC2 box (the run summary's "Pre-deploy dump" row names the file):

```bash
# as the deploy user on the box
/srv/sms/bin/sms-app.sh stop production
/srv/sms/bin/restore-db.sh production /srv/sms/production/backups/sms-production-<…>-pre-deploy-run<N>-<sha7>.dump
#   ^ takes a safety dump first, then replaces the database in ONE transaction
#     (any error rolls back), then ANALYZE. It never starts the API.
cd ~/server && git checkout --quiet --detach <previous sha> && npm run build
/srv/sms/bin/sms-app.sh start production
```

(`npm ci` too, if the lockfile differs between the two SHAs.) Or, once the
database is restored, dispatch this workflow with `ref` = the previous SHA: it
dumps the restored database first, finds no pending migration, and restarts.

On RDS:

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

| Secret | On RDS (the old box) | On the EC2 box |
|---|---|---|
| `PRODUCTION_HOST` | same as `STAGING_HOST` (one box) | the EC2 box's Elastic IP (also `STAGING_HOST`) |
| `PRODUCTION_USER` | same as `STAGING_USER` | `deploy` (also `STAGING_USER`): the box's deploy user, which owns pm2 and `~/server`; no general sudo |
| `PRODUCTION_SSH_KEY` | same as `STAGING_SSH_KEY` | the private half of the key the box bootstrap was given as `SMS_DEPLOY_SSH_PUBKEY` (added with `restrict`) |
| `PRODUCTION_API_URL` | `https://api.startmessaging.com` | unchanged |
| `PRODUCTION_RDS_INSTANCE_ID` | the RDS DB instance identifier | **delete it**: its absence is what selects the on-box dump |
| `AWS_ACCESS_KEY_ID` | IAM user, snapshot permissions only | delete (unused) |
| `AWS_SECRET_ACCESS_KEY` | — | delete (unused) |
| `AWS_REGION` | the RDS instance's region | delete (unused) |

On the EC2 box nothing in AWS is touched: the checkpoint needs only the ssh
secrets. The RDS-world IAM user needs three actions and nothing else:

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
- **No automatic snapshot pruning** (RDS). Snapshots accumulate and cost money.
  Delete old `sm-prod-predeploy-*` ones periodically. On the EC2 box the dumps
  prune themselves: the newest `BACKUP_KEEP_LOCAL` per env stay on the box, and
  the bucket keeps 30 days plus one per month for a year.
- **The front-ends are not in here.** `admin-panel` and `dashboard` are
  Cloudflare Workers; production is `npx wrangler deploy` from a build carrying
  the production env. Never `npm run deploy` — it rebuilds from `.env`, which
  points at localhost.
