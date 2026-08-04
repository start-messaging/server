import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Everything between the initial schema and today, as one step.
 *
 * Production is still on InitialSchema alone — none of the intermediate
 * migrations ever shipped there — so replaying them one at a time would only
 * recreate a history that never existed anywhere real. Several were patches to
 * each other: one added a column to a table another had just created, another
 * altered a default that had only just been set. Folding them together means
 * the tables are created in their final shape, and the whole change is a
 * single transaction that either lands or does not.
 *
 * It covers:
 *
 *  - the read-path indexes for messages, users, payments and wallet
 *    transactions, including the trigram indexes the search endpoints need;
 *  - the affiliate programme: ten enum types and six tables, with the accrual
 *    watermark and the lookback/interval CHECK built into affiliate_settings
 *    rather than bolted on afterwards, and partners defaulting to active
 *    because joining needs no approval;
 *  - a functional index on lower(email), which is what makes sign-in
 *    case-insensitive without a sequential scan;
 *  - convenienceFee and chargedAmount on payments, backfilled so every
 *    historical row keeps its meaning, with a CHECK that the three figures
 *    always reconcile.
 *
 * SAFETY against the live database (416 users, ~56k messages, 119 payments):
 *  - Additive throughout. Nothing is dropped and no existing column changes
 *    type. The only writes to existing rows are the chargedAmount backfill on
 *    payments, which sets it equal to amount.
 *  - The index builds take brief ACCESS SHARE-blocking locks on messages and
 *    users. At this row count that is milliseconds, which is why they are not
 *    CONCURRENT — CONCURRENT cannot run inside the transaction this needs to be.
 *  - The affiliate tables are new, so their foreign key to users validates
 *    instantly against zero rows.
 *
 * Verified by applying it to a restore of production and diffing the resulting
 * schema against the six-migration sequence: identical.
 */
export class ConsolidatedSchema1785500000000 implements MigrationInterface {
  name = 'ConsolidatedSchema1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Read-path indexes ────────────────────────────────
    // Trigram support for index-backed `ILIKE '%term%'` search.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ── messages ───────────────────────────────────────────
    // CRITICAL: provider delivery webhooks look messages up by providerMsgId.
    // Without this index every inbound DLR does a sequential scan of the whole
    // messages table.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_providerMsgId"
        ON "messages" ("providerMsgId")
        WHERE "deletedAt" IS NULL AND "providerMsgId" IS NOT NULL
    `);

    // Admin dashboard/trends/daily-usage aggregate globally over createdAt.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_createdAt"
        ON "messages" ("createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Global status breakdowns (admin dashboard success rate, failed counts).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_status_createdAt"
        ON "messages" ("status", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Customer message list: filter by user + status, order by createdAt.
    // Supersedes the pure (userId, status) index for list queries.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_userId_status_createdAt"
        ON "messages" ("userId", "status", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Customer message list filtered by API key.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_userId_apiKeyId_createdAt"
        ON "messages" ("userId", "apiKeyId", "createdAt" DESC)
        WHERE "deletedAt" IS NULL AND "apiKeyId" IS NOT NULL
    `);

    // Join back from an OTP request to its message.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_otpRequestId"
        ON "messages" ("otpRequestId")
        WHERE "deletedAt" IS NULL AND "otpRequestId" IS NOT NULL
    `);

    // Admin partial phone-number search (`phoneNumber ILIKE '%…%'`).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_phoneNumber_trgm"
        ON "messages" USING gin ("phoneNumber" gin_trgm_ops)
        WHERE "deletedAt" IS NULL
    `);

    // ── users ──────────────────────────────────────────────
    // Looked up on signup and on every mobile-OTP request.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_mobileNumber"
        ON "users" ("mobileNumber")
        WHERE "deletedAt" IS NULL AND "mobileNumber" IS NOT NULL
    `);

    // Admin user list default sort + "new users today/this week" counters.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_createdAt"
        ON "users" ("createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // KYC queue: filter by status, order by submission time.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_kycStatus_kycSubmittedAt"
        ON "users" ("kycStatus", "kycSubmittedAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Active-user counter and account-status filter.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_isActive"
        ON "users" ("isActive")
        WHERE "deletedAt" IS NULL
    `);

    // Admin user list sorted by last login.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_lastLoginAt"
        ON "users" ("lastLoginAt" DESC)
        WHERE "deletedAt" IS NULL AND "lastLoginAt" IS NOT NULL
    `);

    // Single trigram index backing the whole admin user search.
    // The expression MUST stay byte-identical to USER_SEARCH_EXPRESSION in
    // src/users/users.service.ts or the planner will not use this index.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_search_trgm"
        ON "users" USING gin (
          (
            COALESCE("firstName", '') || ' ' ||
            COALESCE("lastName", '') || ' ' ||
            COALESCE("email", '') || ' ' ||
            COALESCE("mobileNumber", '') || ' ' ||
            COALESCE("businessName", '') || ' ' ||
            COALESCE("companyName", '') || ' ' ||
            COALESCE("websiteUrl", '') || ' ' ||
            COALESCE("pan", '') || ' ' ||
            COALESCE("gstin", '')
          ) gin_trgm_ops
        )
        WHERE "deletedAt" IS NULL
    `);

    // ── wallet_transactions ────────────────────────────────
    // Global platform revenue analytics filter on type across all wallets;
    // the existing (walletId, type, createdAt) index cannot serve those
    // because walletId is the leading column.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_tx_type_createdAt"
        ON "wallet_transactions" ("type", "createdAt" DESC)
    `);

    // Per-wallet transaction history without a type filter.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_tx_walletId_createdAt"
        ON "wallet_transactions" ("walletId", "createdAt" DESC)
    `);

    // Trace a transaction back to the message/payment that caused it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_tx_reference"
        ON "wallet_transactions" ("referenceType", "referenceId")
        WHERE "referenceId" IS NOT NULL
    `);

    // ── payments ───────────────────────────────────────────
    // Admin dashboard Razorpay totals (gateway + status, no userId).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_gateway_status_createdAt"
        ON "payments" ("gateway", "status", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Gateway webhooks and checkout verification look up by order id.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_gatewayOrderId"
        ON "payments" ("gatewayOrderId")
        WHERE "deletedAt" IS NULL
    `);

    // ── otp_requests ───────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_otp_requests_createdAt"
        ON "otp_requests" ("createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // ── api_keys ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_api_keys_userId_createdAt"
        ON "api_keys" ("userId", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // ── mobile_otps ────────────────────────────────────────
    // Latest unverified, unexpired OTP for a user during verification.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mobile_otps_userId_verified_createdAt"
        ON "mobile_otps" ("userId", "verified", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // ── otp_templates ──────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_otp_templates_status_channelId"
        ON "otp_templates" ("status", "channelId")
        WHERE "deletedAt" IS NULL
    `);

    // Refresh planner statistics so the new indexes are costed correctly
    // immediately rather than after the next autovacuum cycle.
    await queryRunner.query(`ANALYZE "messages"`);
    await queryRunner.query(`ANALYZE "users"`);
    await queryRunner.query(`ANALYZE "wallet_transactions"`);
    await queryRunner.query(`ANALYZE "payments"`);
    await queryRunner.query(`ANALYZE "otp_requests"`);
    await queryRunner.query(`ANALYZE "api_keys"`);
    await queryRunner.query(`ANALYZE "mobile_otps"`);
    await queryRunner.query(`ANALYZE "otp_templates"`);


    // ── Affiliate programme ──────────────────────────────
    // ── Enum types ─────────────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "affiliate_settings_defaultcommissiontype_enum" AS ENUM('percent', 'flat')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partners_status_enum" AS ENUM('pending', 'active', 'suspended', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partners_commissiontype_enum" AS ENUM('percent', 'flat')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partners_payoutmethod_enum" AS ENUM('bank', 'upi')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partners_kycstatus_enum" AS ENUM('not_submitted', 'pending', 'approved', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "referrals_status_enum" AS ENUM('pending', 'qualified', 'blocked')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partner_commissions_ratetype_enum" AS ENUM('percent', 'flat')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partner_commissions_status_enum" AS ENUM('accrued', 'paid', 'reversed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partner_payouts_status_enum" AS ENUM('pending', 'processing', 'paid', 'failed', 'on_hold')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partner_payouts_payoutmethod_enum" AS ENUM('bank', 'upi')`,
    );

    // ── affiliate_settings (singleton) ─────────────────────
    await queryRunner.query(`
      CREATE TABLE "affiliate_settings" (
        "id"                     uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"              TIMESTAMP WITH TIME ZONE,
        "isSingleton"            boolean NOT NULL DEFAULT true,
        "isEnabled"              boolean NOT NULL DEFAULT false,
        "defaultCommissionType"  "affiliate_settings_defaultcommissiontype_enum" NOT NULL DEFAULT 'percent',
        "defaultCommissionRate"  numeric(12,4) NOT NULL DEFAULT 10,
        "minPaidReferrals"       integer NOT NULL DEFAULT 10,
        "minPayoutAmount"        numeric(12,4) NOT NULL DEFAULT 1000,
        "payoutDayOfMonth"       integer NOT NULL DEFAULT 25,
        "cookieDurationDays"     integer NOT NULL DEFAULT 60,
        "accrualIntervalHours"   integer NOT NULL DEFAULT 48,
        "accrualLookbackHours"   integer NOT NULL DEFAULT 168,
        -- Watermark: start of the last successful accrual run. The accrual
        -- widens its window back to this when the lookback would not reach it,
        -- so an outage longer than the lookback delays commission instead of
        -- losing it. Null until the first run completes.
        "lastAccrualAt"          TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_affiliate_settings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_affiliate_settings_singleton" UNIQUE ("isSingleton"),
        -- A lookback shorter than the interval leaves the difference between
        -- runs permanently unscanned. Enforced here as well as in the service
        -- so a manual UPDATE cannot quietly open the hole.
        CONSTRAINT "CHK_affiliate_settings_lookback_covers_interval"
          CHECK ("accrualLookbackHours" >= "accrualIntervalHours")
      )
    `);

    // ── partners ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "partners" (
        "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"          TIMESTAMP WITH TIME ZONE,
        "email"              character varying NOT NULL,
        "passwordHash"       character varying NOT NULL,
        "firstName"          character varying NOT NULL,
        "lastName"           character varying NOT NULL,
        "phoneNumber"        character varying,
        "companyName"        character varying,
        "referralCode"       character varying(32) NOT NULL,
        -- Active on signup: joining the programme needs no approval. The
        -- control is downstream, at payout.
        "status"             "partners_status_enum" NOT NULL DEFAULT 'active',
        "commissionType"     "partners_commissiontype_enum",
        "commissionRate"     numeric(12,4),
        "payoutMethod"       "partners_payoutmethod_enum",
        "bankAccountName"    character varying,
        "bankAccountNumber"  character varying,
        "bankIfsc"           character varying,
        "upiId"              character varying,
        "pan"                character varying,
        "kycStatus"          "partners_kycstatus_enum" NOT NULL DEFAULT 'not_submitted',
        "adminNotes"         text,
        "lifetimeEarnings"   numeric(12,4) NOT NULL DEFAULT 0,
        "unpaidEarnings"     numeric(12,4) NOT NULL DEFAULT 0,
        "paidEarnings"       numeric(12,4) NOT NULL DEFAULT 0,
        "lastLoginAt"        TIMESTAMP WITH TIME ZONE,
        "refreshTokenHash"   character varying,
        CONSTRAINT "PK_partners" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_partners_email" UNIQUE ("email"),
        CONSTRAINT "UQ_partners_referralCode" UNIQUE ("referralCode")
      )
    `);

    // ── referrals ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "referrals" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"      TIMESTAMP WITH TIME ZONE,
        "partnerId"      uuid NOT NULL,
        "userId"         uuid NOT NULL,
        "referralCode"   character varying(32) NOT NULL,
        "status"         "referrals_status_enum" NOT NULL DEFAULT 'pending',
        "qualifiedAt"    TIMESTAMP WITH TIME ZONE,
        "clickedAt"      TIMESTAMP WITH TIME ZONE,
        "landingPath"    character varying,
        "ipAddress"      character varying,
        "userAgent"      text,
        "blockedReason"  text,
        CONSTRAINT "PK_referrals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_referrals_userId" UNIQUE ("userId")
      )
    `);

    // ── referral_clicks (daily aggregate) ──────────────────
    await queryRunner.query(`
      CREATE TABLE "referral_clicks" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "partnerId"     uuid NOT NULL,
        "date"          date NOT NULL,
        "clicks"        integer NOT NULL DEFAULT 0,
        "uniqueClicks"  integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_referral_clicks" PRIMARY KEY ("id")
      )
    `);

    // ── partner_commissions ────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "partner_commissions" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"       TIMESTAMP WITH TIME ZONE,
        "partnerId"       uuid NOT NULL,
        "referralId"      uuid NOT NULL,
        "userId"          uuid NOT NULL,
        "messageId"       uuid NOT NULL,
        "baseAmount"      numeric(12,4) NOT NULL,
        "rateType"        "partner_commissions_ratetype_enum" NOT NULL,
        "rateValue"       numeric(12,4) NOT NULL,
        "amount"          numeric(12,4) NOT NULL,
        "status"          "partner_commissions_status_enum" NOT NULL DEFAULT 'accrued',
        "payoutId"        uuid,
        "earnedAt"        TIMESTAMP WITH TIME ZONE NOT NULL,
        "reversedReason"  text,
        CONSTRAINT "PK_partner_commissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_partner_commissions_messageId" UNIQUE ("messageId")
      )
    `);

    // ── partner_payouts ────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "partner_payouts" (
        "id"                      uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"               TIMESTAMP WITH TIME ZONE,
        "partnerId"               uuid NOT NULL,
        "periodKey"               character varying(7) NOT NULL,
        "periodStart"             TIMESTAMP WITH TIME ZONE NOT NULL,
        "periodEnd"               TIMESTAMP WITH TIME ZONE NOT NULL,
        "amount"                  numeric(12,4) NOT NULL,
        "commissionCount"         integer NOT NULL DEFAULT 0,
        "qualifiedReferralCount"  integer NOT NULL DEFAULT 0,
        "status"                  "partner_payouts_status_enum" NOT NULL DEFAULT 'pending',
        "payoutMethod"            "partner_payouts_payoutmethod_enum",
        "payoutAccountName"       character varying,
        "payoutAccountRef"        character varying,
        "paidAt"                  TIMESTAMP WITH TIME ZONE,
        "paymentReference"        character varying,
        "processedByAdminId"      uuid,
        "failureReason"           text,
        "adminNotes"              text,
        CONSTRAINT "PK_partner_payouts" PRIMARY KEY ("id")
      )
    `);

    // ── Indexes ────────────────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX "IDX_partners_status_createdAt" ON "partners" ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_referrals_partnerId_status" ON "referrals" ("partnerId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_referrals_partnerId_createdAt" ON "referrals" ("partnerId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_referral_clicks_partnerId_date" ON "referral_clicks" ("partnerId", "date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partner_commissions_partnerId_status" ON "partner_commissions" ("partnerId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partner_commissions_partnerId_createdAt" ON "partner_commissions" ("partnerId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partner_commissions_payoutId" ON "partner_commissions" ("payoutId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partner_payouts_partnerId_createdAt" ON "partner_payouts" ("partnerId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partner_payouts_status_createdAt" ON "partner_payouts" ("status", "createdAt")`,
    );

    // One payout per partner per cycle. This is what makes the monthly run
    // safe to retry: a second attempt collides instead of paying twice.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_partner_payouts_partnerId_periodKey" ON "partner_payouts" ("partnerId", "periodKey")`,
    );

    // Supports the accrual batch's "does this user belong to a partner?" probe.
    await queryRunner.query(
      `CREATE INDEX "IDX_referrals_userId_status" ON "referrals" ("userId", "status") WHERE "deletedAt" IS NULL`,
    );

    // ── Foreign keys ───────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "referrals" ADD CONSTRAINT "FK_referrals_partnerId" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "referrals" ADD CONSTRAINT "FK_referrals_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "referral_clicks" ADD CONSTRAINT "FK_referral_clicks_partnerId" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "partner_commissions" ADD CONSTRAINT "FK_partner_commissions_partnerId" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "partner_commissions" ADD CONSTRAINT "FK_partner_commissions_referralId" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "partner_payouts" ADD CONSTRAINT "FK_partner_payouts_partnerId" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // ── Seed the singleton, disabled ───────────────────────
    await queryRunner.query(`
      INSERT INTO "affiliate_settings" ("isSingleton", "isEnabled")
      VALUES (true, false)
      ON CONFLICT ("isSingleton") DO NOTHING
    `);


    // ── Case-insensitive email lookup ────────────────────
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_email_lower" ON "users" (LOWER("email"))`,
    );


    // ── Convenience fee on payments ──────────────────────
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "convenienceFee" numeric(12,4) NOT NULL DEFAULT 0
    `);

    // Nullable first, backfilled, then constrained — adding it NOT NULL with a
    // default would be fine here too, but this way the backfill is explicit
    // about what it is asserting: every existing payment charged exactly what
    // it credited.
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "chargedAmount" numeric(12,4)
    `);
    await queryRunner.query(`
      UPDATE "payments" SET "chargedAmount" = "amount" WHERE "chargedAmount" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "payments" ALTER COLUMN "chargedAmount" SET NOT NULL
    `);

    // The three figures must always reconcile. A row where they do not is a
    // row where either the customer or the business is out of pocket, and it
    // is cheaper to refuse the write than to find it later in a spreadsheet.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_payments_charged_reconciles'
        ) THEN
          ALTER TABLE "payments"
            ADD CONSTRAINT "CHK_payments_charged_reconciles"
            CHECK ("chargedAmount" = "amount" + "convenienceFee");
        END IF;
      END $$
    `);
  }

  /**
   * Reverses in dependency order: the affiliate tables reference users, so
   * they go before anything else, and the enum types go after the tables that
   * use them.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_charged_reconciles"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "chargedAmount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "convenienceFee"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email_lower"`);

    for (const table of [
      'partner_commissions',
      'partner_payouts',
      'referral_clicks',
      'referrals',
      'partners',
      'affiliate_settings',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    for (const type of [
      'partner_payouts_payoutmethod_enum',
      'partner_payouts_status_enum',
      'partner_commissions_status_enum',
      'partner_commissions_ratetype_enum',
      'referrals_status_enum',
      'partners_kycstatus_enum',
      'partners_payoutmethod_enum',
      'partners_commissiontype_enum',
      'partners_status_enum',
      'affiliate_settings_defaultcommissiontype_enum',
    ]) {
      await queryRunner.query(`DROP TYPE IF EXISTS "${type}"`);
    }

    // The read-path indexes are left in place. They are additive, carry no
    // semantics, and dropping them on a rollback would make the rollback the
    // slow event rather than the fast one.
  }
}
