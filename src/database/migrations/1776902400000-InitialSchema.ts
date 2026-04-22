import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1776902400000 implements MigrationInterface {
  name = 'InitialSchema1776902400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Extension ──────────────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── Enum types ─────────────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "users_role_enum" AS ENUM('admin', 'customer', 'referrer')`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_kycStatus_enum" AS ENUM('not_submitted', 'pending', 'approved', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "messages_status_enum" AS ENUM('initiated', 'queued', 'sent', 'delivered', 'failed', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "otp_requests_status_enum" AS ENUM('pending', 'sent', 'failed', 'verified')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payments_status_enum" AS ENUM('created', 'processing', 'completed', 'failed', 'refunded')`,
    );
    await queryRunner.query(
      `CREATE TYPE "wallet_transactions_type_enum" AS ENUM('credit', 'debit', 'refund')`,
    );

    // ── Tables (independent first, then dependent) ─────────

    // users
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"                    uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"             TIMESTAMP WITH TIME ZONE,
        "email"                 character varying NOT NULL,
        "passwordHash"          character varying,
        "firstName"             character varying NOT NULL,
        "lastName"              character varying NOT NULL,
        "role"                  "users_role_enum" NOT NULL DEFAULT 'customer',
        "isActive"              boolean NOT NULL DEFAULT true,
        "mobileNumber"          character varying,
        "companyName"           character varying,
        "websiteUrl"            character varying,
        "googleId"              character varying,
        "hasCompletedOnboarding" boolean NOT NULL DEFAULT false,
        "country"               character varying(2),
        "refreshTokenHash"      character varying,
        "kycStatus"             "users_kycStatus_enum" NOT NULL DEFAULT 'not_submitted',
        "businessName"          character varying,
        "gstin"                 character varying,
        "pan"                   character varying,
        "businessAddress"       text,
        "kycDocumentPath"       character varying,
        "kycSubmittedAt"        TIMESTAMP WITH TIME ZONE,
        "kycReviewedAt"         TIMESTAMP WITH TIME ZONE,
        "kycReviewedBy"         character varying,
        "kycRejectionReason"    text,
        "mobileVerified"        boolean NOT NULL DEFAULT false,
        "mobileOtpHash"         character varying,
        "mobileOtpExpiresAt"    TIMESTAMP WITH TIME ZONE,
        "lastLoginAt"           TIMESTAMP WITH TIME ZONE,
        "lastLoginIp"           character varying,
        "adminLastCalledAt"     TIMESTAMP WITH TIME ZONE,
        "adminCallNotes"        text,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "UQ_users_googleId" UNIQUE ("googleId")
      )
    `);

    // channels
    await queryRunner.query(`
      CREATE TABLE "channels" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"   TIMESTAMP WITH TIME ZONE,
        "name"        character varying NOT NULL,
        "displayName" character varying NOT NULL,
        "isActive"    boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_channels" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_channels_name" UNIQUE ("name")
      )
    `);

    // wallets
    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "userId"    uuid NOT NULL,
        "balance"   numeric(12,4) NOT NULL DEFAULT 0,
        "currency"  character varying NOT NULL DEFAULT 'INR',
        "version"   integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_wallets" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallets_userId" UNIQUE ("userId")
      )
    `);

    // wallet_transactions
    await queryRunner.query(`
      CREATE TABLE "wallet_transactions" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId"      uuid NOT NULL,
        "type"          "wallet_transactions_type_enum" NOT NULL,
        "amount"        numeric(12,4) NOT NULL,
        "balanceBefore" numeric(12,4) NOT NULL,
        "balanceAfter"  numeric(12,4) NOT NULL,
        "referenceType" character varying,
        "referenceId"   character varying,
        "description"   character varying NOT NULL DEFAULT '',
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_transactions" PRIMARY KEY ("id")
      )
    `);

    // api_keys
    await queryRunner.query(`
      CREATE TABLE "api_keys" (
        "id"         uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"  TIMESTAMP WITH TIME ZONE,
        "userId"     uuid NOT NULL,
        "keyPrefix"  character varying(12) NOT NULL,
        "keyHash"    character varying NOT NULL,
        "label"      character varying NOT NULL DEFAULT '',
        "isActive"   boolean NOT NULL DEFAULT true,
        "allowedIps" text[],
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_api_keys" PRIMARY KEY ("id")
      )
    `);

    // otp_templates
    await queryRunner.query(`
      CREATE TABLE "otp_templates" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "name"      character varying NOT NULL,
        "body"      character varying NOT NULL,
        "channelId" uuid NOT NULL,
        "status"    character varying NOT NULL DEFAULT 'draft',
        "language"  character varying,
        "metadata"  jsonb,
        CONSTRAINT "PK_otp_templates" PRIMARY KEY ("id")
      )
    `);

    // messages
    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id"                        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"                 TIMESTAMP WITH TIME ZONE,
        "userId"                    uuid NOT NULL,
        "apiKeyId"                  character varying,
        "otpRequestId"              character varying,
        "phoneNumber"               character varying NOT NULL,
        "content"                   character varying NOT NULL,
        "provider"                  character varying NOT NULL,
        "providerMsgId"             character varying,
        "status"                    "messages_status_enum" NOT NULL DEFAULT 'initiated',
        "statusHistory"             jsonb NOT NULL DEFAULT '[]',
        "costAmount"                numeric(12,4) NOT NULL DEFAULT 0,
        "senderId"                  character varying,
        "smsLanguage"               character varying,
        "characterCount"            integer NOT NULL DEFAULT 0,
        "smsCount"                  integer NOT NULL DEFAULT 0,
        "providerCost"              numeric(12,4) NOT NULL DEFAULT 0,
        "providerStatusDescription" character varying,
        "metadata"                  jsonb,
        "failureReason"             character varying,
        "sentAt"                    TIMESTAMP WITH TIME ZONE,
        "deliveredAt"               TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_messages" PRIMARY KEY ("id")
      )
    `);

    // otp_requests
    await queryRunner.query(`
      CREATE TABLE "otp_requests" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"   TIMESTAMP WITH TIME ZONE,
        "userId"      uuid NOT NULL,
        "phoneNumber" character varying NOT NULL,
        "code"        character varying,
        "status"      "otp_requests_status_enum" NOT NULL DEFAULT 'pending',
        "expiresAt"   TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_otp_requests" PRIMARY KEY ("id")
      )
    `);

    // payments
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"        TIMESTAMP WITH TIME ZONE,
        "userId"           uuid NOT NULL,
        "gateway"          character varying NOT NULL,
        "gatewayOrderId"   character varying NOT NULL,
        "gatewayPaymentId" character varying,
        "amount"           numeric(12,4) NOT NULL,
        "currency"         character varying NOT NULL DEFAULT 'INR',
        "status"           "payments_status_enum" NOT NULL DEFAULT 'created',
        "metadata"         jsonb,
        "idempotencyKey"   character varying NOT NULL,
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_payments_idempotencyKey" UNIQUE ("idempotencyKey")
      )
    `);

    // mobile_otps
    await queryRunner.query(`
      CREATE TABLE "mobile_otps" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt"   TIMESTAMP WITH TIME ZONE,
        "userId"      uuid NOT NULL,
        "phoneNumber" character varying NOT NULL,
        "otpHash"     character varying NOT NULL,
        "expiresAt"   TIMESTAMP WITH TIME ZONE NOT NULL,
        "attempts"    integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 3,
        "verified"    boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_mobile_otps" PRIMARY KEY ("id")
      )
    `);

    // ── Indexes ────────────────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_tx_walletId_type_createdAt" ON "wallet_transactions" ("walletId", "type", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_userId_isActive" ON "api_keys" ("userId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_userId_createdAt" ON "messages" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_userId_status" ON "messages" ("userId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_senderId" ON "messages" ("senderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_otp_requests_userId_status_createdAt" ON "otp_requests" ("userId", "status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payments_userId_status_createdAt" ON "payments" ("userId", "status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mobile_otps_userId_createdAt" ON "mobile_otps" ("userId", "createdAt")`,
    );

    // ── Foreign keys ───────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD CONSTRAINT "FK_wallets_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ADD CONSTRAINT "FK_wallet_transactions_walletId" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "FK_api_keys_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" ADD CONSTRAINT "FK_otp_templates_channelId" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_requests" ADD CONSTRAINT "FK_otp_requests_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_payments_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Foreign keys ───────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_payments_userId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_requests" DROP CONSTRAINT "FK_otp_requests_userId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_userId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "otp_templates" DROP CONSTRAINT "FK_otp_templates_channelId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP CONSTRAINT "FK_api_keys_userId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" DROP CONSTRAINT "FK_wallet_transactions_walletId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallets" DROP CONSTRAINT "FK_wallets_userId"`,
    );

    // ── Indexes ────────────────────────────────────────────
    await queryRunner.query(`DROP INDEX "IDX_mobile_otps_userId_createdAt"`);
    await queryRunner.query(
      `DROP INDEX "IDX_payments_userId_status_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_otp_requests_userId_status_createdAt"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_messages_senderId"`);
    await queryRunner.query(`DROP INDEX "IDX_messages_userId_status"`);
    await queryRunner.query(`DROP INDEX "IDX_messages_userId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_api_keys_keyHash"`);
    await queryRunner.query(`DROP INDEX "IDX_api_keys_userId_isActive"`);
    await queryRunner.query(
      `DROP INDEX "IDX_wallet_tx_walletId_type_createdAt"`,
    );

    // ── Tables (dependent first, then independent) ─────────
    await queryRunner.query(`DROP TABLE "mobile_otps"`);
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP TABLE "otp_requests"`);
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(`DROP TABLE "otp_templates"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
    await queryRunner.query(`DROP TABLE "wallet_transactions"`);
    await queryRunner.query(`DROP TABLE "wallets"`);
    await queryRunner.query(`DROP TABLE "channels"`);
    await queryRunner.query(`DROP TABLE "users"`);

    // ── Enum types ─────────────────────────────────────────
    await queryRunner.query(`DROP TYPE "wallet_transactions_type_enum"`);
    await queryRunner.query(`DROP TYPE "payments_status_enum"`);
    await queryRunner.query(`DROP TYPE "otp_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE "messages_status_enum"`);
    await queryRunner.query(`DROP TYPE "users_kycStatus_enum"`);
    await queryRunner.query(`DROP TYPE "users_role_enum"`);
  }
}
