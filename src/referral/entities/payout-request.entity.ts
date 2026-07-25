import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { ReferralPartner } from './referral-partner.entity.js';
import { bigintTransformer } from '../../common/database/bigint.transformer.js';

export enum PayoutStatus {
  /** Partner has requested a payout; awaiting admin processing. */
  REQUESTED = 'requested',
  /** Admin has paid the partner. */
  PAID = 'paid',
  /** Admin rejected; the amount is returned to the earnings balance. */
  REJECTED = 'rejected',
}

/**
 * A partner's withdrawal request. Created only inside the monthly payout window
 * and only when thresholds are met. The requested amount is moved out of the
 * earnings balance atomically (a `withdrawal` ledger row) so it can't be
 * double-withdrawn; a rejection returns it (a `reversal` row).
 */
@Index('IDX_payout_requests_partner_status', ['partnerId', 'status'])
@Entity('payout_requests')
export class PayoutRequest extends BaseEntity {
  @Column({ type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => ReferralPartner)
  @JoinColumn({ name: 'partnerId' })
  partner?: ReferralPartner;

  /** Amount requested, in integer micros. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: number;

  @Column({ default: 'INR' })
  currency: string;

  @Column({ type: 'enum', enum: PayoutStatus, default: PayoutStatus.REQUESTED })
  status: PayoutStatus;

  /** Payout window this request belongs to, e.g. '2026-07'. */
  @Column({ type: 'varchar', length: 7 })
  windowMonth: string;

  /** Snapshot of the payout destination at request time. */
  @Column({ type: 'jsonb', nullable: true })
  payoutDetails: Record<string, any> | null;

  /** External transfer reference set when marked paid. */
  @Column({ type: 'varchar', nullable: true })
  payoutRef: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  processedBy: string | null;
}
