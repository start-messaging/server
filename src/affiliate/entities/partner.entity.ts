import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { CommissionType } from './affiliate-settings.entity.js';
import { DecimalTransformer } from '../../common/transformers/decimal.transformer.js';

export enum PartnerStatus {
  /** Signed up, awaiting admin approval. Links do not attribute yet. */
  PENDING = 'pending',
  ACTIVE = 'active',
  /** Attribution and accrual stop; existing earnings are retained. */
  SUSPENDED = 'suspended',
  REJECTED = 'rejected',
}

export enum PayoutMethod {
  BANK = 'bank',
  UPI = 'upi',
}

export enum PartnerKycStatus {
  NOT_SUBMITTED = 'not_submitted',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * An affiliate account.
 *
 * Deliberately a separate table from `users` rather than a role on it:
 * partners authenticate against a different JWT secret, never own a wallet,
 * and need payout/tax details a customer does not have. Keeping them apart
 * means a customer token can never reach a partner route even if a guard is
 * misconfigured, and the customer table does not accumulate columns that are
 * meaningless for 99% of its rows.
 */
@Index('IDX_partners_status_createdAt', ['status', 'createdAt'])
@Entity('partners')
export class Partner extends BaseEntity {
  @Column({ unique: true })
  email: string;

  @Column({ type: 'varchar', select: false })
  passwordHash: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ type: 'varchar', nullable: true })
  phoneNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  companyName: string | null;

  /**
   * The public token in a referral link (`?ref=…`).
   *
   * Unique and indexed because it is resolved on every click, which is
   * unauthenticated traffic and therefore the easiest endpoint to flood.
   */
  @Column({ type: 'varchar', length: 32, unique: true })
  referralCode: string;

  @Column({ type: 'enum', enum: PartnerStatus, default: PartnerStatus.PENDING })
  status: PartnerStatus;

  // ── Commission override ────────────────────────────────

  /**
   * Per-partner commission override. Null means "use the global default",
   * which is the common case — storing a copy of the global rate on every
   * partner would mean a global change silently fails to reach anyone.
   */
  @Column({ type: 'enum', enum: CommissionType, nullable: true })
  commissionType: CommissionType | null;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 4,
    nullable: true,
    transformer: DecimalTransformer,
  })
  commissionRate: number | null;

  // ── Payout details ─────────────────────────────────────

  @Column({ type: 'enum', enum: PayoutMethod, nullable: true })
  payoutMethod: PayoutMethod | null;

  @Column({ type: 'varchar', nullable: true })
  bankAccountName: string | null;

  /** Stored unencrypted only because payouts are executed manually today. */
  @Column({ type: 'varchar', nullable: true })
  bankAccountNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  bankIfsc: string | null;

  @Column({ type: 'varchar', nullable: true })
  upiId: string | null;

  @Column({ type: 'varchar', nullable: true })
  pan: string | null;

  @Column({
    type: 'enum',
    enum: PartnerKycStatus,
    default: PartnerKycStatus.NOT_SUBMITTED,
  })
  kycStatus: PartnerKycStatus;

  @Column({ type: 'text', nullable: true })
  adminNotes: string | null;

  // ── Denormalised running totals ────────────────────────
  //
  // Maintained by the accrual and payout jobs. These are a cache for the
  // dashboard, never the source of truth: every figure can be rebuilt by
  // summing partner_commissions, and a reconciliation check does exactly that.

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 4,
    default: 0,
    transformer: DecimalTransformer,
  })
  lifetimeEarnings: number;

  /** Earned, not yet included in a payout. */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 4,
    default: 0,
    transformer: DecimalTransformer,
  })
  unpaidEarnings: number;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 4,
    default: 0,
    transformer: DecimalTransformer,
  })
  paidEarnings: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  refreshTokenHash: string | null;
}
