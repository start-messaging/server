import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Affiliate / referral program: partner profiles, referral attribution, an
 * append-only commission ledger, and payout requests. Purely additive — no
 * existing table is touched, so no customer data is affected.
 */
export class AffiliateProgram1790000000002 implements MigrationInterface {
  name = 'AffiliateProgram1790000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enums
    await queryRunner.query(
      `CREATE TYPE "referral_profiles_status_enum" AS ENUM('active', 'suspended')`,
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

    // referral_profiles
    await queryRunner.query(`
      CREATE TABLE "referral_profiles" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"       TIMESTAMP WITH TIME ZONE,
        "userId"          uuid NOT NULL,
        "referralCode"    character varying NOT NULL,
        "status"          "referral_profiles_status_enum" NOT NULL DEFAULT 'active',
        "commissionBps"   integer NOT NULL DEFAULT 0,
        "earningsBalance" bigint NOT NULL DEFAULT 0,
        "totalEarned"     bigint NOT NULL DEFAULT 0,
        "paidUsersCount"  integer NOT NULL DEFAULT 0,
        "payoutDetails"   jsonb,
        CONSTRAINT "PK_referral_profiles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_referral_profiles_userId" ON "referral_profiles" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_referral_profiles_code" ON "referral_profiles" ("referralCode")`,
    );

    // referrals
    await queryRunner.query(`
      CREATE TABLE "referrals" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"      TIMESTAMP WITH TIME ZONE,
        "partnerUserId"  uuid NOT NULL,
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
      `CREATE INDEX "IDX_referrals_partnerUserId_status" ON "referrals" ("partnerUserId", "status")`,
    );

    // commission_ledger (append-only)
    await queryRunner.query(`
      CREATE TABLE "commission_ledger" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "partnerUserId"  uuid NOT NULL,
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
      `CREATE INDEX "IDX_commission_ledger_partner_createdAt" ON "commission_ledger" ("partnerUserId", "createdAt")`,
    );

    // payout_requests
    await queryRunner.query(`
      CREATE TABLE "payout_requests" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"       TIMESTAMP WITH TIME ZONE,
        "partnerUserId"   uuid NOT NULL,
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
      `CREATE INDEX "IDX_payout_requests_partner_status" ON "payout_requests" ("partnerUserId", "status")`,
    );

    // Foreign keys
    await queryRunner.query(
      `ALTER TABLE "referral_profiles" ADD CONSTRAINT "FK_referral_profiles_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "referrals" ADD CONSTRAINT "FK_referrals_partnerUserId" FOREIGN KEY ("partnerUserId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "referrals" ADD CONSTRAINT "FK_referrals_referredUserId" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_ledger" ADD CONSTRAINT "FK_commission_ledger_partnerUserId" FOREIGN KEY ("partnerUserId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payout_requests" ADD CONSTRAINT "FK_payout_requests_partnerUserId" FOREIGN KEY ("partnerUserId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payout_requests" DROP CONSTRAINT "FK_payout_requests_partnerUserId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_ledger" DROP CONSTRAINT "FK_commission_ledger_partnerUserId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "referrals" DROP CONSTRAINT "FK_referrals_referredUserId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "referrals" DROP CONSTRAINT "FK_referrals_partnerUserId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "referral_profiles" DROP CONSTRAINT "FK_referral_profiles_userId"`,
    );

    await queryRunner.query(`DROP TABLE "payout_requests"`);
    await queryRunner.query(`DROP TABLE "commission_ledger"`);
    await queryRunner.query(`DROP TABLE "referrals"`);
    await queryRunner.query(`DROP TABLE "referral_profiles"`);

    await queryRunner.query(`DROP TYPE "payout_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE "commission_ledger_type_enum"`);
    await queryRunner.query(`DROP TYPE "referrals_status_enum"`);
    await queryRunner.query(`DROP TYPE "referral_profiles_status_enum"`);
  }
}
