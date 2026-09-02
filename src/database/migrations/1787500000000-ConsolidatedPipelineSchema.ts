import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ten pending migrations between UserTags and today, as one step.
 *
 * None of them ever shipped — they existed only in the working tree, so
 * replaying them one at a time would recreate a history that never ran
 * anywhere real. Several were patches to each other: `Leads` created a `tld`
 * column that `DropLeadTld` removed four migrations later, `LeadTriage`
 * appended a value to an enum `Leads` had just defined, and
 * `PipelineGatesInDb` added two knobs to a settings table `LeadPipelineSettings`
 * had created immediately before. Folded together, the tables are created in
 * their final shape and the whole change is one transaction that either lands
 * or does not. This is the same move as ConsolidatedSchema1785500000000, which
 * collapsed the six pending migrations before it.
 *
 * Collapsed here, in the order they were written:
 *
 *  - OnboardingReminders  — which nudge has been sent to which account
 *  - OneDebitPerMessage   — one delivery debit per message, enforced by index
 *  - Leads                — the customer-acquisition pipeline, four tables
 *  - LeadIndiaSignals     — why a lead was marked Indian, not just that it was
 *  - BrowserEnrichment    — the headless-browser tier's claim column
 *  - LeadTriage           — the 'parked' status and the human rating column
 *  - LeadLiveness         — tier-0 liveness probing
 *  - DropLeadTld          — never creates `tld` in the first place
 *  - LeadPipelineSettings — admin-editable runtime knobs
 *  - PipelineGatesInDb    — the ingest and liveness gates, folded in
 *
 * WHAT DISAPPEARS IN THE FOLD, deliberately:
 *
 *  - `leads.tld` is never created, so it is never dropped, and IDX_leads_tld
 *    never exists. The classifier still resolves the effective TLD internally
 *    to decide keep/drop (compound co.in handling included) — it just stops
 *    being persisted, because it was always derivable from `domain` and the
 *    one thing it usefully encoded is first-class in `isIndian`.
 *  - 'parked' is a value of leads_enrichmentstatus_enum from the start rather
 *    than an ALTER TYPE ADD VALUE, which also retires that migration's caveat
 *    about adding enum values inside a transaction. It is listed last so the
 *    enum's sort order matches what the ten-step sequence produced.
 *  - lead_pipeline_settings is created with ingestEnabled and livenessEnabled
 *    already on it.
 *
 * SAFETY: additive throughout. Every statement is IF NOT EXISTS or guarded by
 * a catalogue lookup, so this is a no-op on a database that already ran the
 * ten — which is every developer machine that has been following along. No
 * existing table is altered and no row is rewritten, with the single exception
 * of the duplicate-debit worklist described below, which only ever inserts
 * into a table this migration creates.
 *
 * INERT ON ITS OWN. The onboarding sweep needs ONBOARDING_REMINDERS_ENABLED,
 * and every leads consumer — ingest scheduler, liveness prober, enrichment
 * sweep, outreach sender — is env-gated off by default. A deployment that sets
 * none of the new variables gains empty tables and nothing else.
 */
export class ConsolidatedPipelineSchema1787500000000
  implements MigrationInterface
{
  name = 'ConsolidatedPipelineSchema1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enum types ────────────────────────────────────────
    // Names follow TypeORM's convention for entity enum columns
    // (<table>_<lowercased column>_enum). Diverging from it makes
    // `migration:generate` propose dropping and recreating the column on every
    // future run.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_reminders_stage_enum') THEN
          CREATE TYPE "onboarding_reminders_stage_enum" AS ENUM ('day_2', 'day_7');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_reminders_status_enum') THEN
          CREATE TYPE "onboarding_reminders_status_enum" AS ENUM ('pending', 'sent', 'failed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leads_source_enum') THEN
          CREATE TYPE "leads_source_enum" AS ENUM ('nrd', 'manual');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leads_status_enum') THEN
          CREATE TYPE "leads_status_enum" AS ENUM (
            'new', 'queued', 'contacted', 'replied', 'converted',
            'unsubscribed', 'bounced', 'disqualified'
          );
        END IF;
        -- 'parked' last: it arrived as an ALTER TYPE ADD VALUE in LeadTriage,
        -- so appending it here reproduces the same enum sort order.
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leads_enrichmentstatus_enum') THEN
          CREATE TYPE "leads_enrichmentstatus_enum" AS ENUM (
            'pending', 'enriched', 'no_contact', 'failed', 'parked'
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leads_liveness_enum') THEN
          CREATE TYPE "leads_liveness_enum" AS ENUM ('unknown', 'live', 'inactive');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_outreach_events_type_enum') THEN
          CREATE TYPE "lead_outreach_events_type_enum" AS ENUM (
            'queued', 'sent', 'opened', 'clicked', 'replied',
            'bounced', 'unsubscribed', 'failed'
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_ingest_runs_status_enum') THEN
          CREATE TYPE "lead_ingest_runs_status_enum" AS ENUM ('pending', 'completed', 'failed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outreach_suppressions_reason_enum') THEN
          CREATE TYPE "outreach_suppressions_reason_enum" AS ENUM ('unsubscribed', 'bounced', 'complaint', 'manual');
        END IF;
      END $$;
    `);

    // ── onboarding_reminders ──────────────────────────────
    // The sweep runs hourly and may run on several instances at once, so
    // "have we already emailed this person?" cannot be answered by a SELECT
    // followed by a send — two processes both read "no" and the customer gets
    // the same message twice. The unique constraint below is where that
    // decision is actually made.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "onboarding_reminders" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"   TIMESTAMP WITH TIME ZONE,
        "userId"      uuid NOT NULL,
        "stage"       "onboarding_reminders_stage_enum" NOT NULL,
        "status"      "onboarding_reminders_status_enum" NOT NULL DEFAULT 'pending',
        "attempts"    integer NOT NULL DEFAULT 0,
        "blockedStep" character varying(40),
        "sentAt"      TIMESTAMP WITH TIME ZONE,
        "lastError"   text,
        CONSTRAINT "PK_onboarding_reminders" PRIMARY KEY ("id")
      )
    `);

    // Not partial on deletedAt: a soft-deleted row must still block a resend,
    // otherwise deleting the record becomes a way to email somebody the same
    // reminder again.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_onboarding_reminders_user_stage') THEN
          ALTER TABLE "onboarding_reminders"
            ADD CONSTRAINT "UQ_onboarding_reminders_user_stage" UNIQUE ("userId", "stage");
        END IF;
        -- Cascade: these rows describe a conversation with an account. Once
        -- the account is gone there is nobody left to have not finished
        -- signing up.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_onboarding_reminders_userId') THEN
          ALTER TABLE "onboarding_reminders" ADD CONSTRAINT "FK_onboarding_reminders_userId"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_onboarding_reminders_userId"
        ON "onboarding_reminders" ("userId")
    `);

    // ── One delivery debit per message ────────────────────
    // The application used to decide whether an SMS had already been paid for
    // by reading the message's own status from an entity loaded outside the
    // transaction. Two status checks arriving together both read a
    // non-delivered status and both charged; and a delivered → failed →
    // delivered sequence, which 2Factor produces on its own, walked through
    // the same guard twice. Either way the customer paid twice for one SMS.
    // The service now asks the ledger under the wallet lock — but an
    // invariant about stored money belongs where a constraint can express it,
    // not only in the one code path that currently happens to respect it.
    //
    // Created unconditionally so the worklist has a home whether or not this
    // database is damaged. It is a report *about* the ledger, derived entirely
    // from it — no money is recorded here that is not also in
    // wallet_transactions.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wallet_transaction_duplicate_debits" (
        "transactionId"     uuid NOT NULL,
        "keptTransactionId" uuid NOT NULL,
        "walletId"          uuid NOT NULL,
        "referenceId"       character varying NOT NULL,
        "amount"            numeric(12,4) NOT NULL,
        "chargedAt"         TIMESTAMP WITH TIME ZONE NOT NULL,
        "detectedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_transaction_duplicate_debits"
          PRIMARY KEY ("transactionId")
      )
    `);

    // Production may already hold duplicate charges written by this very bug,
    // and CREATE UNIQUE INDEX on a table that already violates the invariant
    // fails — which would fail the deploy that fixes the bug. So the build is
    // attempted and, if refused, the damage is recorded and the index is built
    // with its predicate narrowed to rows written from here onwards.
    //
    // Nothing is deleted, nothing is rewritten, no amount is altered. This is
    // a ledger: a duplicate charge is money that genuinely left a customer's
    // wallet. The remedy for a wrong charge is a compensating entry, raised
    // deliberately, not a DELETE inside a migration.
    await queryRunner.query(`
      DO $$
      DECLARE
        cutoff double precision;
        duplicates bigint;
      BEGIN
        -- Re-runnable: a second application must not fail, and must not
        -- widen an index that was deliberately narrowed on the first.
        IF EXISTS (
          SELECT 1 FROM pg_class
           WHERE relname = 'UQ_wallet_tx_otp_usage_debit' AND relkind = 'i'
        ) THEN
          RETURN;
        END IF;

        BEGIN
          CREATE UNIQUE INDEX "UQ_wallet_tx_otp_usage_debit"
            ON "wallet_transactions" ("referenceId")
            WHERE "type" = 'debit'
              AND "referenceType" = 'otp_usage'
              AND "referenceId" IS NOT NULL;

        EXCEPTION WHEN unique_violation THEN
          -- The earliest charge per message is the one kept, every later one
          -- is a duplicate somebody is owed back.
          INSERT INTO "wallet_transaction_duplicate_debits"
            ("transactionId", "keptTransactionId", "walletId",
             "referenceId", "amount", "chargedAt")
          SELECT d."id", d."keptId", d."walletId",
                 d."referenceId", d."amount", d."createdAt"
            FROM (
              SELECT t.*,
                     first_value(t."id") OVER w AS "keptId",
                     row_number()        OVER w AS rn
                FROM "wallet_transactions" t
               WHERE t."type" = 'debit'
                 AND t."referenceType" = 'otp_usage'
                 AND t."referenceId" IS NOT NULL
              WINDOW w AS (
                PARTITION BY t."referenceId"
                ORDER BY t."createdAt", t."id"
              )
            ) d
           WHERE d.rn > 1
          ON CONFLICT DO NOTHING;

          GET DIAGNOSTICS duplicates = ROW_COUNT;

          -- clock_timestamp(), not now(): inside this transaction now() is
          -- the transaction start, and a duplicate written between that
          -- instant and this statement would put the index back out of reach.
          -- to_timestamp(double) is immutable, which a timestamptz literal
          -- cast is not, and an index predicate may only contain immutable
          -- expressions — hence the epoch round trip.
          cutoff := extract(epoch FROM clock_timestamp());

          EXECUTE format(
            'CREATE UNIQUE INDEX %I ON "wallet_transactions" ("referenceId") '
            'WHERE "type" = ''debit'' AND "referenceType" = ''otp_usage'' '
            'AND "referenceId" IS NOT NULL '
            'AND "createdAt" >= to_timestamp(%s)',
            'UQ_wallet_tx_otp_usage_debit', cutoff
          );

          RAISE WARNING
            'One-debit-per-message is enforced from now on only: % duplicate delivery debit(s) already existed and are listed in wallet_transaction_duplicate_debits for refund. Nothing was deleted.',
            duplicates;
        END;
      END $$;
    `);

    // ── leads ─────────────────────────────────────────────
    // Final shape: no `tld` (see the header), and the columns that arrived as
    // follow-ups — indiaSignals, browserAttemptedAt, teamRating, and the three
    // liveness columns — are declared last, in the order they were added, so
    // the table matches what the ten-step sequence produced.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "leads" (
        "id"                    uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"             TIMESTAMP WITH TIME ZONE,
        "domain"                character varying(255) NOT NULL,
        "source"                "leads_source_enum" NOT NULL DEFAULT 'nrd',
        "registeredOn"          date,
        "score"                 integer NOT NULL DEFAULT 0,
        "qualificationScore"    integer NOT NULL DEFAULT 0,
        "qualificationSignals"  jsonb NOT NULL DEFAULT '[]',
        "isIndian"              boolean,
        "status"                "leads_status_enum" NOT NULL DEFAULT 'new',
        "enrichmentStatus"      "leads_enrichmentstatus_enum" NOT NULL DEFAULT 'pending',
        "enrichmentAttempts"    integer NOT NULL DEFAULT 0,
        "enrichedAt"            TIMESTAMP WITH TIME ZONE,
        "enrichmentError"       text,
        "siteTitle"             character varying(500),
        "siteDescription"       text,
        "hasMx"                 boolean,
        "contactEmails"         jsonb NOT NULL DEFAULT '[]',
        "contactPhones"         jsonb NOT NULL DEFAULT '[]',
        "contactWhatsapp"       jsonb NOT NULL DEFAULT '[]',
        "outreachEmail"         character varying(255),
        "outreachToken"         uuid,
        "outreachProviderRef"   character varying(120),
        "queuedAt"              TIMESTAMP WITH TIME ZONE,
        "contactedAt"           TIMESTAMP WITH TIME ZONE,
        "openedAt"              TIMESTAMP WITH TIME ZONE,
        "clickedAt"             TIMESTAMP WITH TIME ZONE,
        "repliedAt"             TIMESTAMP WITH TIME ZONE,
        "notes"                 text,
        "indiaSignals"          jsonb NOT NULL DEFAULT '[]',
        "browserAttemptedAt"    timestamptz,
        "teamRating"            integer,
        "liveness"              "leads_liveness_enum" NOT NULL DEFAULT 'unknown',
        "livenessCheckedAt"     timestamptz,
        "livenessDetail"        character varying(200),
        CONSTRAINT "PK_leads" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        -- UQ_leads_domain is what lets the ingest re-run a day with
        -- ON CONFLICT DO NOTHING instead of an application-side
        -- "have we seen this?" check.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_leads_domain') THEN
          ALTER TABLE "leads" ADD CONSTRAINT "UQ_leads_domain" UNIQUE ("domain");
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_leads_outreachToken') THEN
          ALTER TABLE "leads" ADD CONSTRAINT "UQ_leads_outreachToken" UNIQUE ("outreachToken");
        END IF;
        -- The range lives in the database, not just the DTO: a rating outside
        -- 1–5 is meaningless whatever surface writes it. NULL passes a CHECK
        -- by definition, so "unrated" needs no special case.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_leads_teamRating') THEN
          ALTER TABLE "leads"
            ADD CONSTRAINT "CHK_leads_teamRating" CHECK ("teamRating" BETWEEN 1 AND 5);
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_leads_status" ON "leads" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_leads_enrichmentStatus" ON "leads" ("enrichmentStatus")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_leads_createdAt" ON "leads" ("createdAt")`,
    );
    // Both hot claim queries filter on liveness (prober: unknown/inactive,
    // enrich sweep: live) — worth an index at 100k+ rows/day.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_leads_liveness" ON "leads" ("liveness")`,
    );

    // ── lead_ingest_runs ──────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lead_ingest_runs" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"       TIMESTAMP WITH TIME ZONE,
        "fileDate"        date NOT NULL,
        "status"          "lead_ingest_runs_status_enum" NOT NULL DEFAULT 'pending',
        "totalDomains"    integer NOT NULL DEFAULT 0,
        "matchedDomains"  integer NOT NULL DEFAULT 0,
        "insertedDomains" integer NOT NULL DEFAULT 0,
        "error"           text,
        "finishedAt"      TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_lead_ingest_runs" PRIMARY KEY ("id")
      )
    `);

    // The claim: INSERT ... ON CONFLICT ("fileDate") is the only gate against
    // two workers ingesting the same day's file at once.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_lead_ingest_runs_fileDate') THEN
          ALTER TABLE "lead_ingest_runs"
            ADD CONSTRAINT "UQ_lead_ingest_runs_fileDate" UNIQUE ("fileDate");
        END IF;
      END $$;
    `);

    // ── lead_outreach_events ──────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lead_outreach_events" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"   TIMESTAMP WITH TIME ZONE,
        "leadId"      uuid NOT NULL,
        "type"        "lead_outreach_events_type_enum" NOT NULL,
        "provider"    character varying(40) NOT NULL,
        "payload"     jsonb,
        "occurredAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lead_outreach_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lead_outreach_events_leadId"
        ON "lead_outreach_events" ("leadId")
    `);

    // Cascade: events narrate one lead's outreach. With the lead gone they
    // reference nothing and would only block the delete.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_lead_outreach_events_leadId') THEN
          ALTER TABLE "lead_outreach_events" ADD CONSTRAINT "FK_lead_outreach_events_leadId"
            FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    // ── outreach_suppressions ─────────────────────────────
    // The addresses that must never be mailed again.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outreach_suppressions" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "email"     character varying(255) NOT NULL,
        "reason"    "outreach_suppressions_reason_enum" NOT NULL DEFAULT 'manual',
        "notes"     text,
        CONSTRAINT "PK_outreach_suppressions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_outreach_suppressions_email') THEN
          ALTER TABLE "outreach_suppressions"
            ADD CONSTRAINT "UQ_outreach_suppressions_email" UNIQUE ("email");
        END IF;
      END $$;
    `);

    // ── lead_pipeline_settings ────────────────────────────
    // Same singleton pattern as affiliate_settings. Every knob is NULLABLE and
    // NULL means "use the env default", so this changes nothing by itself: the
    // seeded row overrides no environment until an admin writes a value.
    // ingestEnabled and livenessEnabled are here rather than in a follow-up —
    // every pipeline gate is operated from the panel, not the env file.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lead_pipeline_settings" (
        "id"                  uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"           TIMESTAMP WITH TIME ZONE,
        "isSingleton"         boolean NOT NULL DEFAULT true,
        "enrichEnabled"       boolean,
        "enrichBatchPerSweep" integer,
        "enrichConcurrency"   integer,
        "enrichRecrawlHours"  integer,
        "ingestEnabled"       boolean,
        "livenessEnabled"     boolean,
        CONSTRAINT "PK_lead_pipeline_settings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_lead_pipeline_settings_singleton') THEN
          ALTER TABLE "lead_pipeline_settings"
            ADD CONSTRAINT "UQ_lead_pipeline_settings_singleton" UNIQUE ("isSingleton");
        END IF;
        -- Ranges live in the database, not just the DTO: a concurrency of
        -- 5000 is wrong whatever surface writes it. NULL passes a CHECK.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_lead_pipeline_settings_batch') THEN
          ALTER TABLE "lead_pipeline_settings"
            ADD CONSTRAINT "CHK_lead_pipeline_settings_batch"
              CHECK ("enrichBatchPerSweep" BETWEEN 1 AND 10000);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_lead_pipeline_settings_concurrency') THEN
          ALTER TABLE "lead_pipeline_settings"
            ADD CONSTRAINT "CHK_lead_pipeline_settings_concurrency"
              CHECK ("enrichConcurrency" BETWEEN 1 AND 20);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_lead_pipeline_settings_recrawl') THEN
          ALTER TABLE "lead_pipeline_settings"
            ADD CONSTRAINT "CHK_lead_pipeline_settings_recrawl"
              CHECK ("enrichRecrawlHours" BETWEEN 1 AND 8760);
        END IF;
      END $$;
    `);

    // Seed the singleton (the service also self-heals a missing row).
    await queryRunner.query(`
      INSERT INTO "lead_pipeline_settings" ("isSingleton")
      VALUES (true)
      ON CONFLICT ("isSingleton") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_pipeline_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_outreach_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outreach_suppressions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_ingest_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "leads"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "onboarding_reminders"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wallet_tx_otp_usage_debit"`,
    );
    // Safe to drop: every row in it is derived from wallet_transactions and is
    // regenerated by re-running up(). No ledger row is touched.
    await queryRunner.query(
      `DROP TABLE IF EXISTS "wallet_transaction_duplicate_debits"`,
    );

    await queryRunner.query(`DROP TYPE IF EXISTS "outreach_suppressions_reason_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "lead_ingest_runs_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "lead_outreach_events_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "leads_liveness_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "leads_enrichmentstatus_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "leads_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "leads_source_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "onboarding_reminders_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "onboarding_reminders_stage_enum"`,
    );
  }
}
