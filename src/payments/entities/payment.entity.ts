import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { bigintTransformer } from '../../common/database/bigint.transformer.js';

export enum PaymentStatus {
  CREATED = 'created',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export enum FeeBearer {
  CUSTOMER = 'customer',
  PLATFORM = 'platform',
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
   * Base top-up amount in integer micros — the amount credited to the wallet.
   * The user may pay MORE than this (see convenienceFee/gst/totalAmount) when
   * the customer-fee-bearer model is active.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: number;

  /** Razorpay platform fee passed on to the customer, micros. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  convenienceFee: number;

  /** GST charged on the convenience fee, micros. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  gst: number;

  /** What the gateway actually charges the user = amount + convenienceFee + gst, micros. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  totalAmount: number;

  @Column({ type: 'enum', enum: FeeBearer, default: FeeBearer.CUSTOMER })
  feeBearer: FeeBearer;

  @Column({ default: 'INR' })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.CREATED })
  status: PaymentStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ unique: true })
  idempotencyKey: string;
}
