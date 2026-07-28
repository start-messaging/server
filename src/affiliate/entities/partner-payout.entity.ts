import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { Partner, PayoutMethod } from './partner.entity.js';

export enum PayoutStatus {
  /** Raised by the monthly run, awaiting an admin to send the money. */
  PENDING = 'pending',
  PROCESSING = 'processing',
  PAID = 'paid',
  FAILED = 'failed',
  /** Withheld pending review; the commissions stay attached. */
  ON_HOLD = 'on_hold',
}

/**
 * A single monthly settlement for one partner.
 *
 * Raised by the payout run on the configured day of month, but only when both
 * gates are satisfied: enough referrals have actually paid, and the unpaid
 * balance clears the minimum. Otherwise the balance simply carries into the
 * next cycle.
 */
@Index('IDX_partner_payouts_partnerId_createdAt', ['partnerId', 'createdAt'])
@Index('IDX_partner_payouts_status_createdAt', ['status', 'createdAt'])
// One payout per partner per cycle. This is what makes the monthly run safe to
// retry: a second attempt collides here instead of paying twice.
@Index('UQ_partner_payouts_partnerId_periodKey', ['partnerId', 'periodKey'], {
  unique: true,
})
@Entity('partner_payouts')
export class PartnerPayout extends BaseEntity {
  @Column()
  partnerId: string;

  @ManyToOne(() => Partner)
  @JoinColumn({ name: 'partnerId' })
  partner: Partner;

  /**
   * Human-readable cycle, e.g. `2026-07`.
   *
   * Unique per partner, which is what stops the monthly run from raising a
   * second payout if it is retried, redeployed mid-run, or fired twice.
   */
  @Column({ type: 'varchar', length: 7 })
  periodKey: string;

  @Column({ type: 'timestamptz' })
  periodStart: Date;

  @Column({ type: 'timestamptz' })
  periodEnd: Date;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  amount: number;

  /** How many commission rows this payout settles. */
  @Column({ type: 'int', default: 0 })
  commissionCount: number;

  /** Qualified referrals at the time the run ran, for the audit trail. */
  @Column({ type: 'int', default: 0 })
  qualifiedReferralCount: number;

  @Column({ type: 'enum', enum: PayoutStatus, default: PayoutStatus.PENDING })
  status: PayoutStatus;

  // ── Payout destination, snapshotted ────────────────────
  // Copied from the partner at raise time so changing bank details later never
  // rewrites where past money was actually sent.

  @Column({ type: 'enum', enum: PayoutMethod, nullable: true })
  payoutMethod: PayoutMethod | null;

  @Column({ type: 'varchar', nullable: true })
  payoutAccountName: string | null;

  /** Masked at raise time — full details are never duplicated here. */
  @Column({ type: 'varchar', nullable: true })
  payoutAccountRef: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /** Bank/UPI transaction reference entered by the admin who paid it. */
  @Column({ type: 'varchar', nullable: true })
  paymentReference: string | null;

  @Column({ type: 'uuid', nullable: true })
  processedByAdminId: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ type: 'text', nullable: true })
  adminNotes: string | null;
}
