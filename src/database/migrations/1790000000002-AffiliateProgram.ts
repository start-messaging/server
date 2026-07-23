import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Affiliate / referral program.
 *
 * Partners are a FIRST-CLASS identity (`referral_partners`), separate from
 * customer `users` — they log in to their own portal with email + password.
 * The partner row doubles as the affiliate profile (referral code, commission
 * rate, cached earnings). `referrals` / `commission_ledger` / `payout_requests`
 * are keyed by `partnerId` (→ referral_partners); the referred user is still a
 * customer `users` row.
 *
 * Purely additive to existing customer data — no customer table is touched.
 * The affiliate tables are brand-new in this branch and hold no data, so the
 * up() defensively drops any earlier draft of these tables first, making the
 * migration safe to (re)run whether or not a prior version was applied.
 */
export class AffiliateProgram1790000000002 implements MigrationInterface {
  name = 'AffiliateProgram1790000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive reset — the affiliate feature carries no data, so wiping any
    // earlier draft of these tables is loss-free and keeps re-runs clean.
    await this.dropAll(queryRunner);

    // Enums
    await queryRunner.query(
      `CREATE TYPE "referral_partners_status_enum" AS ENUM('active', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TYPE "referrals_status_enum" AS ENUM('signed_up', 'paid')`,
    );
    await queryRunner.query(
      `CREATE TYPE "commission_ledger_type_enum" AS ENUM('earn', 'withdrawal', 'reversal', 'adjustment')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payout_requests_status_enum" AS ENUM('requested', 'paid', 'rejected')`,
    );

    // referral_partners — identity (email/password) + affiliate profile
    await queryRunner.query(`
      CREATE TABLE "referral_partners" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"        TIMESTAMP WITH TIME ZONE,
        "email"            character varying NOT NULL,
        "passwordHash"     character varying NOT NULL,
        "fullName"         character varying(120) NOT NULL,
        "mobileNumber"     character varying(20),
        "status"           "referral_partners_status_enum" NOT NULL DEFAULT 'active',
        "refreshTokenHash" character varying,
        "lastLoginAt"      TIMESTAMP WITH TIME ZONE,
        "referralCode"     character varying NOT NULL,
        "commissionBps"    integer NOT NULL DEFAULT 0,
        "earningsBalance"  bigint NOT NULL DEFAULT 0,
        "totalEarned"      bigint NOT NULL DEFAULT 0,
        "paidUsersCount"   integer NOT NULL DEFAULT 0,
        "payoutDetails"    jsonb,
        CONSTRAINT "PK_referral_partners" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_referral_partners_email" ON "referral_partners" ("email") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_referral_partners_code" ON "referral_partners" ("referralCode")`,
    );

    // referrals
    await queryRunner.query(`
      CREATE TABLE "referrals" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"      TIMESTAMP WITH TIME ZONE,
        "partnerId"      uuid NOT NULL,
        "referredUserId" uuid NOT NULL,
        "referralCode"   character varying NOT NULL,
        "status"         "referrals_status_enum" NOT NULL DEFAULT 'signed_up',
        "firstPaidAt"    TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_referrals" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_referrals_referredUserId" ON "referrals" ("referredUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_referrals_partnerId_status" ON "referrals" ("partnerId", "status")`,
    );

    // commission_ledger (append-only)
    await queryRunner.query(`
      CREATE TABLE "commission_ledger" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "partnerId"      uuid NOT NULL,
        "type"           "commission_ledger_type_enum" NOT NULL,
        "amount"         bigint NOT NULL,
        "balanceAfter"   bigint NOT NULL,
        "referredUserId" uuid,
        "paymentId"      uuid,
        "payoutId"       uuid,
        "idempotencyKey" character varying(200) NOT NULL,
        "description"    character varying NOT NULL DEFAULT '',
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commission_ledger" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_commission_ledger_idempotency" ON "commission_ledger" ("idempotencyKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commission_ledger_partner_createdAt" ON "commission_ledger" ("partnerId", "createdAt")`,
    );

    // payout_requests
    await queryRunner.query(`
      CREATE TABLE "payout_requests" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"       TIMESTAMP WITH TIME ZONE,
        "partnerId"       uuid NOT NULL,
        "amount"          bigint NOT NULL,
        "currency"        character varying NOT NULL DEFAULT 'INR',
        "status"          "payout_requests_status_enum" NOT NULL DEFAULT 'requested',
        "windowMonth"     character varying(7) NOT NULL,
        "payoutDetails"   jsonb,
        "payoutRef"       character varying,
        "rejectionReason" text,
        "processedAt"     TIMESTAMP WITH TIME ZONE,
        "processedBy"     character varying,
        CONSTRAINT "PK_payout_requests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_payout_requests_partner_status" ON "payout_requests" ("partnerId", "status")`,
    );

    // Foreign keys — partner side → referral_partners, referred side → users.
    await queryRunner.query(
      `ALTER TABLE "referrals" ADD CONSTRAINT "FK_referrals_partnerId" FOREIGN KEY ("partnerId") REFERENCES "referral_partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "referrals" ADD CONSTRAINT "FK_referrals_referredUserId" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_ledger" ADD CONSTRAINT "FK_commission_ledger_partnerId" FOREIGN KEY ("partnerId") REFERENCES "referral_partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_requests" ADD CONSTRAINT "FK_payout_requests_partnerId" FOREIGN KEY ("partnerId") REFERENCES "referral_partners"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.dropAll(queryRunner);
  }

  /**
   * Drop every artifact this migration (or an earlier draft of it) may have
   * created, all IF EXISTS so it is safe on a fresh DB and on one that ran the
   * previous `referral_profiles`-based version. CASCADE clears the FKs.
   */
  private async dropAll(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payout_requests" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "commission_ledger" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "referrals" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "referral_partners" CASCADE`);
    // Legacy draft table (partners used to be a `users` sub-profile).
    await queryRunner.query(`DROP TABLE IF EXISTS "referral_profiles" CASCADE`);

    await queryRunner.query(
      `DROP TYPE IF EXISTS "payout_requests_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "commission_ledger_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "referrals_status_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "referral_partners_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "referral_profiles_status_enum"`,
    );
  }
}
