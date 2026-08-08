import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes a sent message explainable after the fact, and separates what the
 * customer may read from what only an admin may.
 *
 * Three gaps this closes, all found while investigating why multi-variable
 * OTPs stopped arriving after 2026-08-04:
 *
 *  - `otpTemplateId` — nothing recorded which template produced a message.
 *    `messages.content` is the hardcoded literal 'OTP sent' on every row, and
 *    the path message -> otp_requests terminates without touching a template,
 *    so neither the template nor the text was recoverable from any column.
 *
 *  - `renderedContent` — the text actually handed to the provider was
 *    computed and discarded. It is what DLT scrubbing accepts or rejects, so
 *    without it a rejection cannot be diagnosed. Stored with digit runs masked
 *    so the live OTP is not persisted a second time in clear.
 *
 *  - `providerFailureReason` — provider-authored rejection text used to be
 *    written into the customer-visible `failureReason`, disclosing which SMS
 *    provider sits behind the platform. The raw text moves here, which no
 *    customer projection selects; `failureReason` keeps a neutral explanation.
 *
 * All three are nullable with no default, so on PostgreSQL 11+ this is a
 * catalog-only change — no table rewrite on the ~57k existing rows. Existing
 * rows stay NULL: the information to backfill them does not exist anywhere.
 */
export class MessageTraceability1786200000000 implements MigrationInterface {
  name = 'MessageTraceability1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD COLUMN IF NOT EXISTS "otpTemplateId" uuid,
        ADD COLUMN IF NOT EXISTS "renderedContent" character varying,
        ADD COLUMN IF NOT EXISTS "providerFailureReason" character varying
    `);

    // Templates are soft-deleted, never removed, so NO ACTION cannot orphan a
    // row and matches every other foreign key in this schema.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_messages_otpTemplateId'
        ) THEN
          ALTER TABLE "messages"
            ADD CONSTRAINT "FK_messages_otpTemplateId"
            FOREIGN KEY ("otpTemplateId") REFERENCES "otp_templates"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$
    `);

    // "Every message sent with template X, newest first" — the question this
    // column exists to answer, and the one the admin panel now asks.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_otpTemplateId_createdAt"
        ON "messages" ("otpTemplateId", "createdAt" DESC)
        WHERE "otpTemplateId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_messages_otpTemplateId_createdAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_messages_otpTemplateId"`,
    );
    await queryRunner.query(`
      ALTER TABLE "messages"
        DROP COLUMN IF EXISTS "providerFailureReason",
        DROP COLUMN IF EXISTS "renderedContent",
        DROP COLUMN IF EXISTS "otpTemplateId"
    `);
  }
}
