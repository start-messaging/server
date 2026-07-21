import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

export enum ReferralStatus {
  /** Referred user has signed up but not yet paid. */
  SIGNED_UP = 'signed_up',
  /** Referred user has made at least one successful payment. */
  PAID = 'paid',
}

/**
 * Attribution: which partner referred which customer. One row per referred user
 * (a user can only be referred once). Created at signup when a valid referral
 * code is supplied.
 */
@Index('uq_referrals_referredUserId', ['referredUserId'], { unique: true })
@Index('IDX_referrals_partnerUserId_status', ['partnerUserId', 'status'])
@Entity('referrals')
export class Referral extends BaseEntity {
  @Column({ type: 'uuid' })
  partnerUserId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'partnerUserId' })
  partner?: User;

  @Column({ type: 'uuid' })
  referredUserId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'referredUserId' })
  referredUser?: User;

  @Column()
  referralCode: string;

  @Column({
    type: 'enum',
    enum: ReferralStatus,
    default: ReferralStatus.SIGNED_UP,
  })
  status: ReferralStatus;

  @Column({ type: 'timestamptz', nullable: true })
  firstPaidAt: Date | null;
}
