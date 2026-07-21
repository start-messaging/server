import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { bigintTransformer } from '../../common/database/bigint.transformer.js';

export enum ReferralProfileStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * A customer who has joined the affiliate program. 1:1 with a User. Holds the
 * partner's unique referral code, commission rate, and a cached earnings
 * balance (the commission_ledger is the append-only source of truth).
 */
@Index('uq_referral_profiles_userId', ['userId'], { unique: true })
@Index('uq_referral_profiles_code', ['referralCode'], { unique: true })
@Entity('referral_profiles')
export class ReferralProfile extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column()
  referralCode: string;

  @Column({
    type: 'enum',
    enum: ReferralProfileStatus,
    default: ReferralProfileStatus.ACTIVE,
  })
  status: ReferralProfileStatus;

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
