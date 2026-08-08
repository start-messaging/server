import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin-only labels on customer accounts.
 *
 * A join table rather than a text[] column on users, so a tag can be renamed
 * in one place, listed for a picker, and counted — none of which an array of
 * loose strings supports without rewriting every row.
 *
 * Only manually-applied tags live here. Derived facts — how many times an
 * account has topped up, how long it has been a customer — are computed at
 * query time and never stored: a stored "2 top-ups" tag is wrong the moment
 * the third payment lands, and nothing would go back to correct it.
 */
export class UserTags1786300000000 implements MigrationInterface {
  name = 'UserTags1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tags" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"   TIMESTAMP WITH TIME ZONE,
        "name"        character varying(40) NOT NULL,
        "colour"      character varying(20) NOT NULL DEFAULT 'slate',
        "description" character varying(200),
        CONSTRAINT "PK_tags" PRIMARY KEY ("id")
      )
    `);

    // Case-insensitive uniqueness on live rows only, so "VIP" and "vip" cannot
    // both exist while a deleted tag's name stays reusable.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tags_name_live"
        ON "tags" (LOWER("name")) WHERE "deletedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_tags" (
        "userId"    uuid NOT NULL,
        "tagId"     uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdBy" uuid,
        CONSTRAINT "PK_user_tags" PRIMARY KEY ("userId", "tagId")
      )
    `);

    // Cascade on both sides: a row here is a link, not a record worth keeping
    // once either end is gone.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_user_tags_userId') THEN
          ALTER TABLE "user_tags" ADD CONSTRAINT "FK_user_tags_userId"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_user_tags_tagId') THEN
          ALTER TABLE "user_tags" ADD CONSTRAINT "FK_user_tags_tagId"
            FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);

    // "Which customers carry this tag" — the filter the admin list needs. The
    // primary key already covers the other direction.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_tags_tagId" ON "user_tags" ("tagId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_tags"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_tags_name_live"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tags"`);
  }
}
