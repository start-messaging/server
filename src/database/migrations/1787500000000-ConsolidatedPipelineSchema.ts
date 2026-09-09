import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Onboarding reminders, and the one-debit-per-message guard.
 *
 * This started life as a consolidation of ten pending migrations, most of which
 * built the growth/leads pipeline. That pipeline is being extracted into its own
 * service, so the leads tables and their nine enum types were removed from this
 * file: a FRESH environment created from these migrations gets the product
 * schema and nothing else.
 *
 * The class name and timestamp are deliberately UNCHANGED. Staging and every
 * developer database already recorded
 * `ConsolidatedPipelineSchema1787500000000` as applied; renaming it would make
 * TypeORM run it again everywhere for no gain. Those environments still hold the
 * leads tables — dropping them is a separate, deliberate migration to be written
 * only AFTER the 479k rows have been moved to the new service. Do not drop data
 * to tidy a schema.
 *
 * What it still creates:
 *
 *  - onboarding_reminders — which nudge has been sent to which account. The
 *    unique constraint on (userId, stage) is the whole point: the sweep runs
 *    hourly across possibly several instances, so "have we already emailed this
 *    person?" cannot be answered by a SELECT followed by a send.
 *  - wallet_transaction_duplicate_debits + UQ_wallet_tx_otp_usage_debit — at
 *    most one `debit`/`otp_usage` row per message. The application used to
 *    decide this by reading the message's own status outside the transaction,
 *    and a delivered → failed → delivered walk (which 2Factor produces on its
 *    own) charged the customer twice for one SMS. An invariant about stored
 *    money belongs where a constraint can express it.
 *
 * SAFETY: additive throughout, every statement IF NOT EXISTS or catalogue
 * guarded, so it is a no-op on a database that already ran it.
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

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "onboarding_reminders"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wallet_tx_otp_usage_debit"`,
    );
    // Safe to drop: every row in it is derived from wallet_transactions and is
    // regenerated by re-running up(). No ledger row is touched.
    await queryRunner.query(
      `DROP TABLE IF EXISTS "wallet_transaction_duplicate_debits"`,
    );

    await queryRunner.query(
      `DROP TYPE IF EXISTS "onboarding_reminders_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "onboarding_reminders_stage_enum"`,
    );
  }
}
