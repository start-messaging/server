import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves OTP templates from global/admin-owned to per-user ownership with an
 * admin review workflow. Existing global templates become APPROVED SYSTEM
 * templates (userId stays NULL), so no data is lost and every current template
 * keeps working.
 */
export class UserLevelTemplates1790000000001 implements MigrationInterface {
  name = 'UserLevelTemplates1790000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD COLUMN "userId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD COLUMN "rejectionReason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD COLUMN "submittedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD COLUMN "reviewedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD COLUMN "reviewedBy" character varying`,
    );

    // Existing global templates → approved system templates.
    await queryRunner.query(
      `UPDATE "otp_templates" SET "status" = 'approved' WHERE "status" = 'published'`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_otp_templates_userId_status" ON "otp_templates" ("userId", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD CONSTRAINT "FK_otp_templates_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "otp_templates" DROP CONSTRAINT "FK_otp_templates_userId"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_otp_templates_userId_status"`);

    // Collapse new statuses back to the original draft/published pair.
    await queryRunner.query(
      `UPDATE "otp_templates" SET "status" = 'published' WHERE "status" = 'approved'`,
    );
    await queryRunner.query(
      `UPDATE "otp_templates" SET "status" = 'draft' WHERE "status" IN ('pending_review', 'rejected')`,
    );

    await queryRunner.query(
      `ALTER TABLE "otp_templates" DROP COLUMN "reviewedBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" DROP COLUMN "reviewedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" DROP COLUMN "submittedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" DROP COLUMN "rejectionReason"`,
    );
    await queryRunner.query(`ALTER TABLE "otp_templates" DROP COLUMN "userId"`);
  }
}
