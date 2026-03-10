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

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  amount: number;

  @Column({ default: 'INR' })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.CREATED })
  status: PaymentStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ unique: true })
  idempotencyKey: string;
}
