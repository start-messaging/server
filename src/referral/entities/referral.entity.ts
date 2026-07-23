import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { ReferralPartner } from './referral-partner.entity.js';

export enum ReferralStatus {
  /** Referred user has signed up but not yet paid. */
  SIGNED_UP = 'signed_up',
  /** Referred user has made at least one successful payment. */
  PAID = 'paid',
}

/**
 * Attribution: which partner referred which customer. One row per referred user
 * (a user can only be referred once). Created at signup when a valid referral
 * code is supplied. The partner is a `referral_partners` row; the referred user
 * is a customer `users` row.
 */
@Index('uq_referrals_referredUserId', ['referredUserId'], { unique: true })
@Index('IDX_referrals_partnerId_status', ['partnerId', 'status'])
@Entity('referrals')
export class Referral extends BaseEntity {
  @Column({ type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => ReferralPartner)
  @JoinColumn({ name: 'partnerId' })
  partner?: ReferralPartner;

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
