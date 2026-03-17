import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

export enum MessageStatus {
  INITIATED = 'initiated',
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  EXPIRED = 'expired',
}

@Index('IDX_messages_userId_createdAt', ['userId', 'createdAt'])
@Index('IDX_messages_userId_status', ['userId', 'status'])
@Index('IDX_messages_senderId', ['senderId'])
@Entity('messages')
export class Message extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', nullable: true })
  apiKeyId: string | null;

  @Column({ type: 'varchar', nullable: true })
  otpRequestId: string | null;

  @Column()
  phoneNumber: string;

  @Column()
  content: string;

  @Column()
  provider: string;

  @Column({ type: 'varchar', nullable: true })
  providerMsgId: string | null;

  @Column({ type: 'enum', enum: MessageStatus, default: MessageStatus.INITIATED })
  status: MessageStatus;

  @Column({ type: 'jsonb', default: [] })
  statusHistory: { status: string; timestamp: string }[];

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  costAmount: number;

  @Column({ type: 'varchar', nullable: true })
  senderId: string | null;

  @Column({ type: 'varchar', nullable: true })
  smsLanguage: string | null;

  @Column({ type: 'integer', default: 0 })
  characterCount: number;

  @Column({ type: 'integer', default: 0 })
  smsCount: number;

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  providerCost: number;

  @Column({ type: 'varchar', nullable: true })
  providerStatusDescription: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: any;

  @Column({ type: 'varchar', nullable: true })
  failureReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}
