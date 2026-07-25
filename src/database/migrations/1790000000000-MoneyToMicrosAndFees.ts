import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts every money column from `numeric(12,4)` rupees to `bigint` integer
 * micros (1 unit = 1,000,000 micros) and adds the Razorpay convenience-fee
 * breakdown to `payments`. All existing rows are preserved: values are
 * multiplied by 1,000,000 in place via `USING round(...)`.
 */
export class MoneyToMicrosAndFees1790000000000 implements MigrationInterface {
  name = 'MoneyToMicrosAndFees1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- wallets.balance ---
    await queryRunner.query(
      `ALTER TABLE "wallets" ALTER COLUMN "balance" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ALTER COLUMN "balance" TYPE bigint USING round("balance" * 1000000)`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ALTER COLUMN "balance" SET DEFAULT 0`,
    );

    // --- wallet_transactions (amount, balanceBefore, balanceAfter) ---
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "amount" TYPE bigint USING round("amount" * 1000000)`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "balanceBefore" TYPE bigint USING round("balanceBefore" * 1000000)`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "balanceAfter" TYPE bigint USING round("balanceAfter" * 1000000)`,
    );

    // --- messages (costAmount, providerCost, metadata.intendedCost) ---
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "costAmount" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "costAmount" TYPE bigint USING round("costAmount" * 1000000)`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "costAmount" SET DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "providerCost" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "providerCost" TYPE bigint USING round("providerCost" * 1000000)`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "providerCost" SET DEFAULT 0`,
    );
    await queryRunner.query(
      `UPDATE "messages" SET "metadata" = jsonb_set("metadata", '{intendedCost}', to_jsonb(round(("metadata"->>'intendedCost')::numeric * 1000000))) WHERE "metadata" ? 'intendedCost'`,
    );

    // --- payments.amount → micros, plus fee-breakdown columns ---
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "amount" TYPE bigint USING round("amount" * 1000000)`,
    );
    await queryRunner.query(
      `CREATE TYPE "payments_feeBearer_enum" AS ENUM('customer', 'platform')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN "convenienceFee" bigint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN "gst" bigint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN "totalAmount" bigint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN "feeBearer" "payments_feeBearer_enum" NOT NULL DEFAULT 'customer'`,
    );
    // Existing payments pre-date the fee model: the platform bore the fee and
    // the charged total equalled the (now micros) base amount.
    await queryRunner.query(
      `UPDATE "payments" SET "totalAmount" = "amount", "feeBearer" = 'platform'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // payments fee columns
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "feeBearer"`);
    await queryRunner.query(`DROP TYPE "payments_feeBearer_enum"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "totalAmount"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "gst"`);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "convenienceFee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "amount" TYPE numeric(12,4) USING ("amount" / 1000000.0)`,
    );

    // messages
    await queryRunner.query(
      `UPDATE "messages" SET "metadata" = jsonb_set("metadata", '{intendedCost}', to_jsonb(("metadata"->>'intendedCost')::numeric / 1000000)) WHERE "metadata" ? 'intendedCost'`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "providerCost" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "providerCost" TYPE numeric(12,4) USING ("providerCost" / 1000000.0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "providerCost" SET DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "costAmount" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "costAmount" TYPE numeric(12,4) USING ("costAmount" / 1000000.0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "costAmount" SET DEFAULT 0`,
    );

    // wallet_transactions
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "balanceAfter" TYPE numeric(12,4) USING ("balanceAfter" / 1000000.0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "balanceBefore" TYPE numeric(12,4) USING ("balanceBefore" / 1000000.0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "amount" TYPE numeric(12,4) USING ("amount" / 1000000.0)`,
    );

    // wallets
    await queryRunner.query(
      `ALTER TABLE "wallets" ALTER COLUMN "balance" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ALTER COLUMN "balance" TYPE numeric(12,4) USING ("balance" / 1000000.0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" ALTER COLUMN "balance" SET DEFAULT 0`,
    );
  }
}
