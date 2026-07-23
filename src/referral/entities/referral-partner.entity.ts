import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { bigintTransformer } from '../../common/database/bigint.transformer.js';

export enum ReferralPartnerStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * A referral / affiliate partner — a first-class identity that is SEPARATE from
 * a customer `users` row. Partners log in to their own portal with email +
 * password (see PartnerAuthService) and this same row doubles as their
 * affiliate profile: it owns the referral code, commission rate, and the cached
 * earnings balance (the append-only `commission_ledger` is the source of
 * truth). Keeping partners independent means a person can be both a Google
 * customer and an email/password partner under the same address without
 * colliding on the customer table.
 */
@Index('uq_referral_partners_email', ['email'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Index('uq_referral_partners_code', ['referralCode'], { unique: true })
@Entity('referral_partners')
export class ReferralPartner extends BaseEntity {
  // ── Identity / auth ──────────────────────────────────
  /** Stored lower-cased; uniqueness is case-insensitive via normalisation. */
  @Column({ type: 'varchar' })
  email: string;

  @Column({ type: 'varchar' })
  passwordHash: string;

  @Column({ type: 'varchar', length: 120 })
  fullName: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mobileNumber: string | null;

  @Column({
    type: 'enum',
    enum: ReferralPartnerStatus,
    default: ReferralPartnerStatus.ACTIVE,
  })
  status: ReferralPartnerStatus;

  /** SHA-256 of the current refresh token (rotated on every refresh). */
  @Column({ type: 'varchar', nullable: true })
  refreshTokenHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  // ── Affiliate profile ────────────────────────────────
  @Column()
  referralCode: string;

  /** Commission rate in basis points (1000 bps = 10%). */
  @Column({ type: 'int', default: 0 })
  commissionBps: number;

  /** Available earnings that can be withdrawn, in integer micros. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  earningsBalance: number;

  /** Lifetime earned commission, in integer micros. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  totalEarned: number;

  /** Cached count of referred users who have made at least one payment. */
  @Column({ type: 'int', default: 0 })
  paidUsersCount: number;

  /** Payout destination (UPI id / bank details) supplied by the partner. */
  @Column({ type: 'jsonb', nullable: true })
  payoutDetails: Record<string, any> | null;
}
