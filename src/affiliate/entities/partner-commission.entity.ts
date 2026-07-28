import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { Partner } from './partner.entity.js';
import { Referral } from './referral.entity.js';
import { CommissionType } from './affiliate-settings.entity.js';

export enum CommissionStatus {
  /** Earned and counted in unpaid earnings. */
  ACCRUED = 'accrued',
  /** Included in a payout that has been settled. */
  PAID = 'paid',
  /** Clawed back — refund, chargeback or fraud. */
  REVERSED = 'reversed',
}

/**
 * One row per delivered OTP that earned a partner money. The append-only
 * source of truth for everything the partner is owed.
 *
 * The running totals on `partners` are a cache derived from these rows; if the
 * two ever disagree, this table wins and the cache is rebuilt.
 */
@Index('IDX_partner_commissions_partnerId_status', ['partnerId', 'status'])
@Index('IDX_partner_commissions_partnerId_createdAt', [
  'partnerId',
  'createdAt',
])
@Index('IDX_partner_commissions_payoutId', ['payoutId'])
@Entity('partner_commissions')
export class PartnerCommission extends BaseEntity {
  @Column()
  partnerId: string;

  @ManyToOne(() => Partner)
  @JoinColumn({ name: 'partnerId' })
  partner: Partner;

  @Column()
  referralId: string;

  @ManyToOne(() => Referral)
  @JoinColumn({ name: 'referralId' })
  referral: Referral;

  /** Denormalised from the referral so per-customer breakdowns avoid a join. */
  @Column({ type: 'uuid' })
  userId: string;

  /**
   * The delivered message this commission was earned on.
   *
   * UNIQUE, and that constraint is the whole safety mechanism for the money.
   * The accrual batch re-scans an overlapping window and may run twice after a
   * retry or a deploy; without this, either case would pay the partner twice
   * for the same OTP. With it, a duplicate insert simply fails and is skipped.
   */
  @Column({ type: 'uuid', unique: true })
  messageId: string;

  /** The message's cost — the amount commission was calculated from. */
  @Column({ type: 'decimal', precision: 12, scale: 4 })
  baseAmount: number;

  /**
   * The rate in force at accrual time, snapshotted.
   *
   * Without this, changing the global rate would silently rewrite the meaning
   * of every historical row and make past payouts unreproducible.
   */
  @Column({ type: 'enum', enum: CommissionType })
  rateType: CommissionType;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  rateValue: number;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  amount: number;

  @Column({
    type: 'enum',
    enum: CommissionStatus,
    default: CommissionStatus.ACCRUED,
  })
  status: CommissionStatus;

  /** Set when a payout run sweeps this row up. */
  @Column({ type: 'uuid', nullable: true })
  payoutId: string | null;

  /** The message's delivery time — the period a payout run buckets on. */
  @Column({ type: 'timestamptz' })
  earnedAt: Date;

  @Column({ type: 'text', nullable: true })
  reversedReason: string | null;
}
