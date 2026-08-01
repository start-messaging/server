import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Affiliate / partner referral programme.
 *
 * SAFETY: purely additive. Creates six new tables and their enum types, and
 * seeds one settings row. No existing table, column, constraint or row is
 * altered or dropped, so no customer data can be affected by running or
 * reverting it.
 *
 * The programme ships DISABLED (`affiliate_settings.isEnabled = false`).
 * Nothing attributes, accrues or pays out until an admin turns it on, so
 * applying this migration is inert until you decide otherwise.
 */
export class AffiliateProgram1785110400000 implements MigrationInterface {
  name = 'AffiliateProgram1785110400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
        -- losing it permanently. Null until the first run completes.
        "lastAccrualAt"          TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_affiliate_settings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_affiliate_settings_singleton" UNIQUE ("isSingleton"),
        -- A lookback shorter than the interval leaves the difference
        -- permanently unscanned. Enforced in the database as well as the
        -- service so a manual UPDATE cannot quietly create the hole.
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
        "status"             "partners_status_enum" NOT NULL DEFAULT 'pending',
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops only what up() created. No pre-existing table is touched.
    await queryRunner.query(`DROP TABLE IF EXISTS "partner_payouts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "partner_commissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "referral_clicks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "referrals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "partners"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "affiliate_settings"`);

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
  }
}
