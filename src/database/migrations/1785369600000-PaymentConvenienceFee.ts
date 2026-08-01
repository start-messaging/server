import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separates what a customer is charged from what their wallet is credited.
 *
 * Until now `payments.amount` was both, because they were always equal — the
 * gateway's cut came out of the merchant's margin. With a convenience fee the
 * two diverge, so the charged figure needs somewhere to live and the fee needs
 * recording per payment rather than recomputed from a rate that will change.
 *
 * SAFETY: additive, and backfills so existing rows keep their meaning —
 * every historical payment had no surcharge, so `chargedAmount` is `amount`
 * and the fee is zero. `payments` is small (113 rows on the production
 * restore), so the rewrite the NOT NULL backfill costs is negligible.
 *
 * Applying this changes nothing on its own: the surcharge is gated behind
 * CONVENIENCE_FEE_ENABLED, which defaults to false.
 */
export class PaymentConvenienceFee1785369600000 implements MigrationInterface {
  name = 'PaymentConvenienceFee1785369600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_charged_reconciles"
    `);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "chargedAmount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "convenienceFee"`,
    );
  }
}
