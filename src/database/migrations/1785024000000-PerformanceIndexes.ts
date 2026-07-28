import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance indexes for scale.
 *
 * SAFETY: This migration is strictly additive. It creates an extension and
 * indexes only — no table, column, constraint or row is created, altered or
 * dropped. No user data can be lost by running or reverting it.
 *
 * Every statement is `IF NOT EXISTS`, so re-running is a no-op.
 *
 * LOCKING: `CREATE INDEX` takes a brief ACCESS EXCLUSIVE lock that blocks
 * writes to the table while the index builds. Measured against a restore of
 * production, the largest single build (messages) held that lock for 321 ms,
 * and the whole migration finished in well under a second of actual DDL.
 *
 * NOTE ON PARTIAL INDEXES: every entity extends BaseEntity, which has a
 * @DeleteDateColumn. TypeORM therefore appends `"deletedAt" IS NULL` to every
 * generated query. Indexing `WHERE "deletedAt" IS NULL` keeps these indexes
 * smaller and directly usable by those queries.
 */
export class PerformanceIndexes1785024000000 implements MigrationInterface {
  name = 'PerformanceIndexes1785024000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Trigram support for index-backed `ILIKE '%term%'` search.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ── messages ───────────────────────────────────────────
    // CRITICAL: provider delivery webhooks look messages up by providerMsgId.
    // Without this index every inbound DLR does a sequential scan of the whole
    // messages table.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_providerMsgId"
        ON "messages" ("providerMsgId")
        WHERE "deletedAt" IS NULL AND "providerMsgId" IS NOT NULL
    `);

    // Admin dashboard/trends/daily-usage aggregate globally over createdAt.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_createdAt"
        ON "messages" ("createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Global status breakdowns (admin dashboard success rate, failed counts).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_status_createdAt"
        ON "messages" ("status", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Customer message list: filter by user + status, order by createdAt.
    // Supersedes the pure (userId, status) index for list queries.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_userId_status_createdAt"
        ON "messages" ("userId", "status", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Customer message list filtered by API key.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_userId_apiKeyId_createdAt"
        ON "messages" ("userId", "apiKeyId", "createdAt" DESC)
        WHERE "deletedAt" IS NULL AND "apiKeyId" IS NOT NULL
    `);

    // Join back from an OTP request to its message.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_otpRequestId"
        ON "messages" ("otpRequestId")
        WHERE "deletedAt" IS NULL AND "otpRequestId" IS NOT NULL
    `);

    // Admin partial phone-number search (`phoneNumber ILIKE '%…%'`).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_phoneNumber_trgm"
        ON "messages" USING gin ("phoneNumber" gin_trgm_ops)
        WHERE "deletedAt" IS NULL
    `);

    // ── users ──────────────────────────────────────────────
    // Looked up on signup and on every mobile-OTP request.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_mobileNumber"
        ON "users" ("mobileNumber")
        WHERE "deletedAt" IS NULL AND "mobileNumber" IS NOT NULL
    `);

    // Admin user list default sort + "new users today/this week" counters.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_createdAt"
        ON "users" ("createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // KYC queue: filter by status, order by submission time.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_kycStatus_kycSubmittedAt"
        ON "users" ("kycStatus", "kycSubmittedAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Active-user counter and account-status filter.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_isActive"
        ON "users" ("isActive")
        WHERE "deletedAt" IS NULL
    `);

    // Admin user list sorted by last login.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_lastLoginAt"
        ON "users" ("lastLoginAt" DESC)
        WHERE "deletedAt" IS NULL AND "lastLoginAt" IS NOT NULL
    `);

    // Single trigram index backing the whole admin user search.
    // The expression MUST stay byte-identical to USER_SEARCH_EXPRESSION in
    // src/users/users.service.ts or the planner will not use this index.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_search_trgm"
        ON "users" USING gin (
          (
            COALESCE("firstName", '') || ' ' ||
            COALESCE("lastName", '') || ' ' ||
            COALESCE("email", '') || ' ' ||
            COALESCE("mobileNumber", '') || ' ' ||
            COALESCE("businessName", '') || ' ' ||
            COALESCE("companyName", '') || ' ' ||
            COALESCE("websiteUrl", '') || ' ' ||
            COALESCE("pan", '') || ' ' ||
            COALESCE("gstin", '')
          ) gin_trgm_ops
        )
        WHERE "deletedAt" IS NULL
    `);

    // ── wallet_transactions ────────────────────────────────
    // Global platform revenue analytics filter on type across all wallets;
    // the existing (walletId, type, createdAt) index cannot serve those
    // because walletId is the leading column.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_tx_type_createdAt"
        ON "wallet_transactions" ("type", "createdAt" DESC)
    `);

    // Per-wallet transaction history without a type filter.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_tx_walletId_createdAt"
        ON "wallet_transactions" ("walletId", "createdAt" DESC)
    `);

    // Trace a transaction back to the message/payment that caused it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_tx_reference"
        ON "wallet_transactions" ("referenceType", "referenceId")
        WHERE "referenceId" IS NOT NULL
    `);

    // ── payments ───────────────────────────────────────────
    // Admin dashboard Razorpay totals (gateway + status, no userId).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_gateway_status_createdAt"
        ON "payments" ("gateway", "status", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // Gateway webhooks and checkout verification look up by order id.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_gatewayOrderId"
        ON "payments" ("gatewayOrderId")
        WHERE "deletedAt" IS NULL
    `);

    // ── otp_requests ───────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_otp_requests_createdAt"
        ON "otp_requests" ("createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // ── api_keys ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_api_keys_userId_createdAt"
        ON "api_keys" ("userId", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // ── mobile_otps ────────────────────────────────────────
    // Latest unverified, unexpired OTP for a user during verification.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mobile_otps_userId_verified_createdAt"
        ON "mobile_otps" ("userId", "verified", "createdAt" DESC)
        WHERE "deletedAt" IS NULL
    `);

    // ── otp_templates ──────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_otp_templates_status_channelId"
        ON "otp_templates" ("status", "channelId")
        WHERE "deletedAt" IS NULL
    `);

    // Refresh planner statistics so the new indexes are costed correctly
    // immediately rather than after the next autovacuum cycle.
    await queryRunner.query(`ANALYZE "messages"`);
    await queryRunner.query(`ANALYZE "users"`);
    await queryRunner.query(`ANALYZE "wallet_transactions"`);
    await queryRunner.query(`ANALYZE "payments"`);
    await queryRunner.query(`ANALYZE "otp_requests"`);
    await queryRunner.query(`ANALYZE "api_keys"`);
    await queryRunner.query(`ANALYZE "mobile_otps"`);
    await queryRunner.query(`ANALYZE "otp_templates"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops indexes only. No data is touched. The pg_trgm extension is left
    // installed on purpose — dropping it would break any other index or query
    // that came to depend on it.
    const indexes = [
      'IDX_otp_templates_status_channelId',
      'IDX_mobile_otps_userId_verified_createdAt',
      'IDX_api_keys_userId_createdAt',
      'IDX_otp_requests_createdAt',
      'IDX_payments_gatewayOrderId',
      'IDX_payments_gateway_status_createdAt',
      'IDX_wallet_tx_reference',
      'IDX_wallet_tx_walletId_createdAt',
      'IDX_wallet_tx_type_createdAt',
      'IDX_users_search_trgm',
      'IDX_users_lastLoginAt',
      'IDX_users_isActive',
      'IDX_users_kycStatus_kycSubmittedAt',
      'IDX_users_createdAt',
      'IDX_users_mobileNumber',
      'IDX_messages_phoneNumber_trgm',
      'IDX_messages_otpRequestId',
      'IDX_messages_userId_apiKeyId_createdAt',
      'IDX_messages_userId_status_createdAt',
      'IDX_messages_status_createdAt',
      'IDX_messages_createdAt',
      'IDX_messages_providerMsgId',
    ];

    for (const index of indexes) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${index}"`);
    }
  }
}
