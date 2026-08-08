import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Outbound email campaigns and their analytics.
 *
 * Four tables rather than one wide one, because they have genuinely different
 * lifetimes: a campaign is written once and read constantly, a recipient row is
 * updated a handful of times, events are append-only and outnumber recipients
 * by an order of magnitude, and suppressions outlive every campaign that
 * created them.
 *
 * Open and click tracking is served by this application, not by the mail
 * provider — hence `email_events` existing at all. That is what keeps the
 * dashboard working when the transport is a free SMTP relay that reports
 * nothing back, and keeps the engagement history in this database rather than
 * in a vendor's.
 */
export class EmailCampaigns1786400000000 implements MigrationInterface {
  name = 'EmailCampaigns1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum type names match what TypeORM derives from table + column, so the
    // entities line up with these rather than trying to create their own.
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "email_campaigns_status_enum" AS ENUM
          ('draft','scheduled','queued','sending','sent','paused','cancelled','failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "email_campaigns_audiencetype_enum" AS ENUM ('segment','manual');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "email_campaign_recipients_status_enum" AS ENUM
          ('pending','sending','sent','delivered','opened','clicked',
           'bounced','complained','unsubscribed','skipped','failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "email_events_event_enum" AS ENUM
          ('accepted','delivered','opened','clicked','bounced','complained','unsubscribed','failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "email_suppressions_reason_enum" AS ENUM
          ('unsubscribed','complained','bounced','manual');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // ── Campaigns ──────────────────────────────────────
    //
    // The counter columns are denormalised from email_campaign_recipients. A
    // campaign of twenty thousand people produces six figures of events, and
    // the list screen would otherwise run that aggregation once per row per
    // page render.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_campaigns" (
        "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"          TIMESTAMP WITH TIME ZONE,
        "name"               character varying(160) NOT NULL,
        "subject"            character varying(300) NOT NULL,
        "preheader"          character varying(300),
        "bodyHtml"           text NOT NULL,
        "replyTo"            character varying(320),
        "status"             "email_campaigns_status_enum" NOT NULL DEFAULT 'draft',
        "audienceType"       "email_campaigns_audiencetype_enum" NOT NULL DEFAULT 'segment',
        "audienceFilter"     jsonb,
        "trackOpens"         boolean NOT NULL DEFAULT true,
        "trackClicks"        boolean NOT NULL DEFAULT true,
        "scheduledAt"        TIMESTAMP WITH TIME ZONE,
        "startedAt"          TIMESTAMP WITH TIME ZONE,
        "completedAt"        TIMESTAMP WITH TIME ZONE,
        "createdBy"          uuid,
        "errorMessage"       text,
        "totalRecipients"    integer NOT NULL DEFAULT 0,
        "sentCount"          integer NOT NULL DEFAULT 0,
        "deliveredCount"     integer NOT NULL DEFAULT 0,
        "openedCount"        integer NOT NULL DEFAULT 0,
        "clickedCount"       integer NOT NULL DEFAULT 0,
        "bouncedCount"       integer NOT NULL DEFAULT 0,
        "complainedCount"    integer NOT NULL DEFAULT 0,
        "unsubscribedCount"  integer NOT NULL DEFAULT 0,
        "failedCount"        integer NOT NULL DEFAULT 0,
        "skippedCount"       integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_email_campaigns" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_campaigns_status"
        ON "email_campaigns" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_campaigns_createdAt"
        ON "email_campaigns" ("createdAt" DESC)
    `);

    // ── Recipients ─────────────────────────────────────
    //
    // Name and company are copied rather than read through "userId": a
    // recipient may be a pasted lead with no account, and for those who do
    // have one the row must keep saying who we mailed even after they change
    // their address.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_campaign_recipients" (
        "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"         TIMESTAMP WITH TIME ZONE,
        "campaignId"        uuid NOT NULL,
        "userId"            uuid,
        "email"             character varying(320) NOT NULL,
        "firstName"         character varying(120),
        "lastName"          character varying(120),
        "companyName"       character varying(200),
        "status"            "email_campaign_recipients_status_enum" NOT NULL DEFAULT 'pending',
        "providerMessageId" character varying(255),
        "sentAt"            TIMESTAMP WITH TIME ZONE,
        "deliveredAt"       TIMESTAMP WITH TIME ZONE,
        "firstOpenedAt"     TIMESTAMP WITH TIME ZONE,
        "lastOpenedAt"      TIMESTAMP WITH TIME ZONE,
        "firstClickedAt"    TIMESTAMP WITH TIME ZONE,
        "openCount"         integer NOT NULL DEFAULT 0,
        "clickCount"        integer NOT NULL DEFAULT 0,
        "errorMessage"      text,
        CONSTRAINT "PK_email_campaign_recipients" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_email_recipients_campaignId') THEN
          ALTER TABLE "email_campaign_recipients"
            ADD CONSTRAINT "FK_email_recipients_campaignId"
            FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);

    // The same person can match a segment filter *and* appear in the pasted
    // list. Without this they receive two copies of a cold email, which is the
    // fastest route to a spam complaint — and it is what makes re-running a
    // failed send top the list up rather than duplicate it.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_recipients_campaign_email"
        ON "email_campaign_recipients" ("campaignId", "email")
        WHERE "deletedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_recipients_campaign_status"
        ON "email_campaign_recipients" ("campaignId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_recipients_email"
        ON "email_campaign_recipients" ("email")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_recipients_providerMessageId"
        ON "email_campaign_recipients" ("providerMessageId")
        WHERE "providerMessageId" IS NOT NULL
    `);
    // Drives the rolling daily send cap, which counts sends across every
    // campaign in the last 24 hours.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_recipients_sentAt"
        ON "email_campaign_recipients" ("sentAt")
        WHERE "sentAt" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_recipients_userId"
        ON "email_campaign_recipients" ("userId")
        WHERE "userId" IS NOT NULL
    `);

    // ── Events ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_events" (
        "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"         TIMESTAMP WITH TIME ZONE,
        "campaignId"        uuid,
        "recipientId"       uuid,
        "email"             character varying(320) NOT NULL,
        "event"             "email_events_event_enum" NOT NULL,
        "providerEventId"   character varying(255),
        "providerMessageId" character varying(255),
        "url"               text,
        "reason"            text,
        "ip"                character varying(64),
        "city"              character varying(120),
        "country"           character varying(8),
        "deviceType"        character varying(40),
        "clientName"        character varying(120),
        "occurredAt"        TIMESTAMP WITH TIME ZONE NOT NULL,
        "raw"               jsonb,
        CONSTRAINT "PK_email_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_email_events_campaignId') THEN
          ALTER TABLE "email_events"
            ADD CONSTRAINT "FK_email_events_campaignId"
            FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);

    // A provider retries a webhook until it gets a 200, so the same event
    // arrives repeatedly whenever a deploy makes us time out. This turns those
    // retries into a conflict the writer can swallow rather than a doubled
    // open count.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_events_providerEventId"
        ON "email_events" ("providerEventId")
        WHERE "providerEventId" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_events_campaign_type"
        ON "email_events" ("campaignId", "event")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_events_recipient"
        ON "email_events" ("recipientId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_events_occurredAt"
        ON "email_events" ("occurredAt")
    `);

    // ── Suppressions ───────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_suppressions" (
        "id"         uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"  TIMESTAMP WITH TIME ZONE,
        "email"      character varying(320) NOT NULL,
        "reason"     "email_suppressions_reason_enum" NOT NULL,
        "campaignId" uuid,
        "note"       text,
        "createdBy"  uuid,
        CONSTRAINT "PK_email_suppressions" PRIMARY KEY ("id")
      )
    `);

    // Live rows only, so an address an admin deliberately un-suppressed can be
    // suppressed again later without colliding with the historical row.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_suppressions_email"
        ON "email_suppressions" ("email") WHERE "deletedAt" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Events and recipients cascade from campaigns, but are dropped explicitly
    // so the order does not depend on the constraints having been created.
    await queryRunner.query(`DROP TABLE IF EXISTS "email_events"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "email_campaign_recipients"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "email_suppressions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "email_campaigns"`);

    await queryRunner.query(
      `DROP TYPE IF EXISTS "email_suppressions_reason_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "email_events_event_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "email_campaign_recipients_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "email_campaigns_audiencetype_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "email_campaigns_status_enum"`);
  }
}
