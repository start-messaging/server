import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One wallet credit per payment, enforced by the database.
 *
 * Until now "a payment is credited once" was true only because every code path
 * took a row lock on the payment and checked its status first. That holds as
 * long as every path remembers to, forever. This index makes it a property of
 * the data instead: a second credit for the same payment cannot be written, by
 * any code, including a path written next year.
 *
 * Partial, on credits whose reference is a payment: debits and refunds
 * legitimately repeat a reference (a message is debited and later refunded),
 * and manual credits ('admin_topup') carry free-text references.
 *
 * Verified against production on 2026-10-27 before this was written: zero
 * duplicate payment credits and zero payment credits without a reference, so
 * the index builds without touching a row. If a duplicate ever does exist when
 * this runs it fails loudly rather than choosing which credit to discard — that
 * is a customer's money and a human decision.
 */
export class PaymentCreditOnce1793000000000 implements MigrationInterface {
  name = 'PaymentCreditOnce1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_tx_payment_credit"
        ON "wallet_transactions" ("referenceId")
        WHERE "type" = 'credit'
          AND "referenceType" = 'payment'
          AND "referenceId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wallet_tx_payment_credit"`,
    );
  }
}
