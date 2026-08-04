import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires the partner approval flow.
 *
 * Signing up as an affiliate no longer waits for an admin. The control that
 * mattered was never this one — a referral code on its own pays nobody, and a
 * payout still needs `minPaidReferrals` qualified referrals, a balance over
 * `minPayoutAmount`, and an admin recording the outcome by hand. Approval only
 * delayed people who were going to be approved.
 *
 * Two things happen here:
 *
 *  - the column default moves to 'active', so a row written by anything that
 *    bypasses the entity layer lands in the right state;
 *  - every partner still sitting at 'pending' is moved to 'active'. Without
 *    this they would be stranded: `PartnerJwtStrategy` rejects any status that
 *    is not ACTIVE, and nothing would ever move them on now that the approval
 *    screen is gone.
 *
 * The 'pending' enum value is deliberately left in place. Removing a value
 * from a Postgres enum means rebuilding the type and every column that uses
 * it, which is a lot of lock for no benefit — nothing writes it any more.
 *
 * SAFETY: `partners` is empty in production (the affiliate programme has not
 * shipped), so in practice this updates nothing there. It is written to be
 * correct anyway, because the same migration runs against environments where
 * partners were created during testing.
 */
export class PartnersActiveOnSignup1785456000000 implements MigrationInterface {
  name = 'PartnersActiveOnSignup1785456000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "partners" ALTER COLUMN "status" SET DEFAULT 'active'`,
    );

    // Ends in a SELECT so the count comes back as a row: a bare
    // `UPDATE … RETURNING` is handed back as `[rows, affectedCount]` here, and
    // reading `.length` off that reports 2 however many rows changed.
    const [{ moved }] = (await queryRunner.query(
      `WITH activated AS (
         UPDATE "partners" SET "status" = 'active', "updatedAt" = now()
          WHERE "status" = 'pending'
         RETURNING "id"
       )
       SELECT COUNT(*)::int AS moved FROM activated`,
    )) as { moved: number }[];

    if (moved > 0) {
      // Worth saying out loud: these accounts become able to attribute
      // referrals the moment this runs.
      console.log(
        `[PartnersActiveOnSignup] activated ${moved} previously pending partner(s)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the default is restored. Which partners were pending before is not
    // recorded anywhere, and guessing would suspend people who are legitimately
    // active — so the rows are left as they are.
    await queryRunner.query(
      `ALTER TABLE "partners" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
  }
}
