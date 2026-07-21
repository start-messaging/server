import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { Channel } from './channel.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { TemplateStatus } from '../enums/template-status.enum.js';

@Index('IDX_otp_templates_userId_status', ['userId', 'status'])
@Entity('otp_templates')
export class OtpTemplate extends BaseEntity {
  /**
   * Owner of the template. `null` = a SYSTEM template — shared, admin-authored,
   * usable by everyone. A non-null userId scopes the template to that customer.
   */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column()
  name: string;

  @Column()
  body: string;

  @Column()
  channelId: string;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channelId' })
  channel: Channel;

  @Column({
    type: 'varchar',
    default: TemplateStatus.DRAFT,
  })
  status: TemplateStatus;

  @Column({ type: 'varchar', nullable: true })
  language: string | null;

  /**
   * Provider-side identifiers (e.g. 2Factor template name, Fast2SMS DLT id).
   * These are set by admin during approval — the user does not self-register
   * DLT ids — so this is admin-managed, not customer-editable.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  /** Populated when admin rejects a submission. */
  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  /** When the user submitted the template for review. */
  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  /** When admin approved/rejected. */
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /** Admin user id who reviewed. */
  @Column({ type: 'varchar', nullable: true })
  reviewedBy: string | null;
}
