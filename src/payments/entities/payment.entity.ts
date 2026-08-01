import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

export enum PaymentStatus {
  CREATED = 'created',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

@Index('IDX_payments_userId_status_createdAt', [
  'userId',
  'status',
  'createdAt',
])
@Entity('payments')
export class Payment extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  gateway: string;

  @Column()
  gatewayOrderId: string;

  @Column({ type: 'varchar', nullable: true })
  gatewayPaymentId: string | null;

  /**
   * What the customer receives — the wallet is credited exactly this.
   *
   * Deliberately NOT what the card is charged. When a convenience fee applies
   * the two differ, and keeping `amount` as the credited figure means every
   * existing consumer (the wallet credit on both the verify and webhook paths,
   * and the admin top-up totals) keeps meaning what it always meant.
   */
  @Column({ type: 'decimal', precision: 12, scale: 4 })
  amount: number;

  /**
   * The gateway's cut, passed on to the customer. Zero when absorbed.
   *
   * Stored per payment rather than recomputed from the current rate, because
   * the rate is configuration and will change — a historical payment has to
   * stay reconcilable against what was actually charged at the time.
   */
  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  convenienceFee: number;

  /**
   * What the gateway actually charges the customer: `amount + convenienceFee`.
   *
   * This is the figure the Razorpay order is created for, and the one a
   * webhook's reported amount must match.
   */
  @Column({ type: 'decimal', precision: 12, scale: 4 })
  chargedAmount: number;

  @Column({ default: 'INR' })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.CREATED })
  status: PaymentStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ unique: true })
  idempotencyKey: string;
}
