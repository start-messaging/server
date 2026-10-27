import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives each OTP template what 2Factor's R1 endpoint needs to send it: its DLT
 * Content Template ID, and the DLT-approved text with its `{#var#}` slots.
 *
 * R1 replaced the older TSMS endpoint after 2Factor asked for the move (an
 * intermittent "Missing template name value" refusal). It is addressed by
 * template name plus numbered variables, and the operator checks the assembled
 * message against the approved template — so the approved text has to be kept
 * beside the template, to read the variable values back out of the message we
 * render (see sms-providers/providers/two-factor-template.ts for why they
 * cannot be taken from our own placeholders).
 *
 * Values read from the DLT portal (dlt-registration.2factor.in → My DLT
 * Templates) on 2026-10-27, all Approved, sender STMSG. They are identifiers,
 * not secrets. The PE ID is account-wide and lives in TWOFACTOR_PE_ID.
 *
 * Matched on the 2Factor template name already stored in `metadata.2factor`,
 * so a database without these templates (a fresh dev or test database) is
 * simply untouched, and running it twice changes nothing. OTP_WITH_NAME exists
 * at 2Factor but not here, so there is nothing to update for it.
 */
const TEMPLATES: { name: string; ctid: string; text: string }[] = [
  {
    name: 'OTP',
    ctid: '1107177288857285984',
    text: 'Your OTP is {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  },
  {
    name: 'OTP_WITH_APPNAME',
    ctid: '1107178040819809682',
    text: 'Your {#var#} OTP is {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  },
  {
    name: 'OTP_WITH_EXPIRY',
    ctid: '1107178040829019543',
    text: 'Your OTP is {#var#}, valid for {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  },
  {
    name: 'OTP_WITH_APPNAME_EXPIRY',
    ctid: '1107178040840345992',
    text: 'Your {#var#} OTP is {#var#}, valid for {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  },
];

export class TwoFactorR1TemplateIds1793100000000 implements MigrationInterface {
  name = 'TwoFactorR1TemplateIds1793100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const t of TEMPLATES) {
      await queryRunner.query(
        `UPDATE "otp_templates"
            SET "metadata" = COALESCE("metadata", '{}'::jsonb)
                             || jsonb_build_object('2factor_ctid', $2::text,
                                                   '2factor_dlt_text', $3::text)
          WHERE "metadata"->>'2factor' = $1
            AND "deletedAt" IS NULL`,
        [t.name, t.ctid, t.text],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "otp_templates"
          SET "metadata" = "metadata" - '2factor_ctid' - '2factor_dlt_text'
        WHERE "metadata" ? '2factor_ctid'`,
    );
  }
}
