import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { EmailRecipientStatus } from '../enums/email-recipient-status.enum.js';
import { EmailCampaign } from './email-campaign.entity.js';

/**
 * One person on one campaign.
 *
 * The address, name and company are copied here at send time rather than read
 * through `userId` on display. Two reasons: a recipient may be a pasted lead
 * with no account at all, and for those who do have one, the row has to keep
 * saying who we mailed even after the customer changes their email.
 */
@Index('UQ_email_recipients_campaign_email', ['campaignId', 'email'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Index('IDX_email_recipients_campaign_status', ['campaignId', 'status'])
@Index('IDX_email_recipients_email', ['email'])
@Index('IDX_email_recipients_providerMessageId', ['providerMessageId'])
@Entity('email_campaign_recipients')
export class EmailCampaignRecipient extends BaseEntity {
  @Column({ type: 'uuid' })
  campaignId: string;

  @ManyToOne(() => EmailCampaign, (c) => c.recipients, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId' })
  campaign: EmailCampaign;

  /** Null for pasted addresses that match no account. */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  firstName: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  lastName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  companyName: string | null;

  @Column({
    type: 'enum',
    enum: EmailRecipientStatus,
    default: EmailRecipientStatus.PENDING,
  })
  status: EmailRecipientStatus;

  /**
   * Mailgun's `Message-Id` for this send.
   *
   * Each recipient gets its own API call rather than a batched one precisely so
   * this is unique per person: batch sends return a single id for up to a
   * thousand recipients, which makes a `delivered` webhook impossible to
   * attribute without falling back to string-matching the address.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerMessageId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  firstOpenedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastOpenedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  firstClickedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  openCount: number;

  @Column({ type: 'int', default: 0 })
  clickCount: number;

  /** Why this address was skipped, or how the send failed. */
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;
}
