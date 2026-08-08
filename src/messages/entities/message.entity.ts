import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { OtpTemplate } from '../../channels/entities/otp-template.entity.js';

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

  /**
   * The template that actually produced this message — the resolved one, so a
   * request naming a draft or missing template records NULL rather than
   * claiming a template whose body was never used.
   */
  @Column({ type: 'uuid', nullable: true })
  otpTemplateId: string | null;

  @ManyToOne(() => OtpTemplate, { nullable: true })
  @JoinColumn({ name: 'otpTemplateId' })
  otpTemplate: OtpTemplate | null;

  /**
   * The text handed to the provider, with digit runs masked. `content` stores
   * a fixed placeholder, so this is the only record of what was actually sent
   * — and DLT accepts or rejects on exactly this text.
   */
  @Column({ type: 'varchar', nullable: true })
  renderedContent: string | null;

  /**
   * The provider's own rejection wording. Deliberately absent from every
   * customer projection: it names the provider. `failureReason` carries the
   * neutral explanation shown to customers.
   */
  @Column({ type: 'varchar', nullable: true })
  providerFailureReason: string | null;

  @Column()
  phoneNumber: string;

  @Column()
  content: string;

  @Column()
  provider: string;

  @Column({ type: 'varchar', nullable: true })
  providerMsgId: string | null;

  @Column({
    type: 'enum',
    enum: MessageStatus,
    default: MessageStatus.INITIATED,
  })
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
