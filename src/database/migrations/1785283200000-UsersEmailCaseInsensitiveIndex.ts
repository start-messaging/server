import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Functional index supporting case-insensitive email lookup.
 *
 * `findByEmail` now matches on `LOWER(email)`, because the column is
 * case-sensitive while email in practice is not: registering `Sam@x.com` and
 * then `sam@x.com` produced two accounts for one person, each with its own
 * wallet, and logging in with the wrong capitalisation returned "Invalid
 * credentials". Without this index that lookup is a sequential scan on every
 * login and every registration.
 *
 * Deliberately NOT unique. A unique index would be the stronger guarantee, but
 * it fails outright if any two existing rows differ only by case — turning a
 * deploy into an outage. Check first:
 *
 *   SELECT lower(email), count(*) FROM users WHERE "deletedAt" IS NULL
 *    GROUP BY 1 HAVING count(*) > 1;
 *
 * If that returns nothing, a follow-up migration can promote this to UNIQUE.
 *
 * SAFETY: additive and idempotent. `users` is small enough that building the
 * index is effectively instant; it takes a brief SHARE lock on the table.
 */
export class UsersEmailCaseInsensitiveIndex1785283200000
  implements MigrationInterface
{
  name = 'UsersEmailCaseInsensitiveIndex1785283200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_email_lower" ON "users" (LOWER("email"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email_lower"`);
  }
}
