import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { Partner } from './partner.entity.js';
import { User } from '../../users/entities/user.entity.js';

export enum ReferralStatus {
  /** Signed up via the link but has not completed a payment yet. */
  PENDING = 'pending',
  /** Has >= 1 completed payment, so counts toward the payout threshold. */
  QUALIFIED = 'qualified',
  /** Excluded by an admin — fraud, self-referral, chargebacks. */
  BLOCKED = 'blocked',
}

/**
 * The permanent link between a referred customer and the partner who sent them.
 *
 * `userId` is unique: a customer belongs to exactly one partner, forever. The
 * cookie can be overwritten by a later click before signup (last touch wins),
 * but once this row exists attribution is frozen — otherwise a partner could
 * re-cookie an existing customer and steal an account that is already earning
 * for someone else.
 */
@Index('IDX_referrals_partnerId_status', ['partnerId', 'status'])
@Index('IDX_referrals_partnerId_createdAt', ['partnerId', 'createdAt'])
// Serves the accrual batch's "does this user belong to a partner?" probe,
// which runs once per delivered message in the window.
@Index('IDX_referrals_userId_status', ['userId', 'status'], {
  where: '"deletedAt" IS NULL',
})
@Entity('referrals')
export class Referral extends BaseEntity {
  @Column()
  partnerId: string;

  @ManyToOne(() => Partner)
  @JoinColumn({ name: 'partnerId' })
  partner: Partner;

  /** Unique — one customer can never be attributed to two partners. */
  @Column({ unique: true })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  /** The code as it was used, kept for audit if the partner later changes it. */
  @Column({ type: 'varchar', length: 32 })
  referralCode: string;

  @Column({
    type: 'enum',
    enum: ReferralStatus,
    default: ReferralStatus.PENDING,
  })
  status: ReferralStatus;

  /**
   * When the referred user's first payment completed.
   *
   * This is what "paid user" means for the payout threshold. Stored rather
   * than derived so the threshold check is a cheap COUNT instead of a join
   * across the whole payments table on every dashboard load.
   */
  @Column({ type: 'timestamptz', nullable: true })
  qualifiedAt: Date | null;

  // ── Attribution audit ──────────────────────────────────
  // Kept so a disputed commission can be traced back to the click that
  // created it.

  @Column({ type: 'timestamptz', nullable: true })
  clickedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  landingPath: string | null;

  @Column({ type: 'varchar', nullable: true })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ type: 'text', nullable: true })
  blockedReason: string | null;
}
