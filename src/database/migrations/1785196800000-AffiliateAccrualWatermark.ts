import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the accrual watermark and the lookback/interval invariant.
 *
 * Written as a follow-up rather than folded into 1785110400000 because that
 * migration has already been applied in at least one environment. TypeORM
 * records a migration by name, so editing an applied one in place is silently
 * a no-op there: the column would be missing at runtime and `recordAccrualRun`
 * would fail on every accrual.
 *
 * SAFETY: additive and idempotent. One nullable column and one CHECK on a
 * single-row table, both `IF NOT EXISTS`-guarded, so it costs no meaningful
 * lock and can be re-run.
 */
export class AffiliateAccrualWatermark1785196800000
  implements MigrationInterface
{
  name = 'AffiliateAccrualWatermark1785196800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Start of the last successful accrual run. The accrual widens its window
    // back to this when the lookback would not reach it, so an outage longer
    // than `accrualLookbackHours` delays commission rather than losing it.
    // Nullable: on an existing row there is no run to point at yet, and the
    // accrual treats NULL as "just use the lookback".
    await queryRunner.query(`
      ALTER TABLE "affiliate_settings"
        ADD COLUMN IF NOT EXISTS "lastAccrualAt" TIMESTAMP WITH TIME ZONE
    `);

    // A lookback shorter than the interval leaves the difference between runs
    // permanently unscanned. Any row already in that state is repaired before
    // the constraint is added, otherwise adding it would fail outright — and
    // widening the lookback is the correct repair regardless, since it is the
    // value that was too small.
    await queryRunner.query(`
      UPDATE "affiliate_settings"
         SET "accrualLookbackHours" = "accrualIntervalHours",
             "updatedAt" = now()
       WHERE "accrualLookbackHours" < "accrualIntervalHours"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_affiliate_settings_lookback_covers_interval'
        ) THEN
          ALTER TABLE "affiliate_settings"
            ADD CONSTRAINT "CHK_affiliate_settings_lookback_covers_interval"
            CHECK ("accrualLookbackHours" >= "accrualIntervalHours");
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "affiliate_settings"
        DROP CONSTRAINT IF EXISTS "CHK_affiliate_settings_lookback_covers_interval"
    `);
    await queryRunner.query(`
      ALTER TABLE "affiliate_settings" DROP COLUMN IF EXISTS "lastAccrualAt"
    `);
  }
}
