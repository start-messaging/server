import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { EmailCampaignStatus } from '../enums/email-campaign-status.enum.js';
import { EmailCampaignRecipient } from './email-campaign-recipient.entity.js';

/** How the recipient list for a campaign was chosen. */
export enum EmailAudienceType {
  /** A filter over the customer table, resolved at send time. */
  SEGMENT = 'segment',
  /** Addresses typed or pasted into the composer. */
  MANUAL = 'manual',
}

/**
 * The filter that produced a segment audience.
 *
 * Stored alongside the campaign so the panel can show *why* someone was
 * included months later. It is not re-run after send — the recipient rows are
 * the record of who was actually mailed, and re-resolving would silently
 * disagree with them as accounts change.
 */
export interface EmailAudienceFilter {
  /** Account status: active accounts only, suspended only, or either. */
  status?: 'active' | 'suspended';
  kycStatus?: string[];
  /** Customers carrying *any* of these admin tags. */
  tagIds?: string[];
  /** ISO-3166 alpha-2, matched against `users.country`. */
  country?: string;
  hasCompletedOnboarding?: boolean;
  /** Signed up on or after this instant (ISO 8601). */
  createdAfter?: string;
  createdBefore?: string;
  /** Restrict to accounts that have never topped up — the classic cold list. */
  neverToppedUp?: boolean;
}

/**
 * One outbound email send: the message, who it went to, and what came back.
 *
 * Counters are denormalised onto this row rather than aggregated from
 * `email_events` on every read. A campaign to twenty thousand people produces
 * six figures of events, and the list screen would otherwise run a
 * multi-hundred-thousand row GROUP BY per page render. The events table stays
 * the audit trail; these are the numbers the panel actually paints.
 */
@Index('IDX_email_campaigns_status', ['status'])
@Index('IDX_email_campaigns_createdAt', ['createdAt'])
@Entity('email_campaigns')
export class EmailCampaign extends BaseEntity {
  /** Internal label. Never shown to a recipient. */
  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 300 })
  subject: string;

  /**
   * Inbox-preview text, injected as a hidden block ahead of the body.
   *
   * Without one, clients preview the first readable text in the HTML — which
   * for a templated email is whatever the header happens to contain, repeated
   * across every campaign.
   */
  @Column({ type: 'varchar', length: 300, nullable: true })
  preheader: string | null;

  /** Composer output. Trusted admin input, rendered inside the brand shell. */
  @Column({ type: 'text' })
  bodyHtml: string;

  /**
   * Overrides the configured Reply-To for this campaign only.
   *
   * Cold outreach is usually answered, and the replies should reach whoever
   * sent it rather than the shared no-reply mailbox.
   */
  @Column({ type: 'varchar', length: 320, nullable: true })
  replyTo: string | null;

  @Column({
    type: 'enum',
    enum: EmailCampaignStatus,
    default: EmailCampaignStatus.DRAFT,
  })
  status: EmailCampaignStatus;

  @Column({
    type: 'enum',
    enum: EmailAudienceType,
    default: EmailAudienceType.SEGMENT,
  })
  audienceType: EmailAudienceType;

  @Column({ type: 'jsonb', nullable: true })
  audienceFilter: EmailAudienceFilter | null;

  @Column({ default: true })
  trackOpens: boolean;

  @Column({ default: true })
  trackClicks: boolean;

  /**
   * When the dispatcher should start.
   *
   * Held on the row as well as in BullMQ's delayed set so the panel can show
   * and change it without reading queue internals.
   */
  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  /** Set when the campaign itself failed to dispatch, not a single recipient. */
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  // ── Denormalised counters ────────────────────────────
  // Every one of these is derivable from `email_campaign_recipients`; they
  // exist so the list and detail screens are two cheap reads.

  @Column({ type: 'int', default: 0 })
  totalRecipients: number;

  @Column({ type: 'int', default: 0 })
  sentCount: number;

  @Column({ type: 'int', default: 0 })
  deliveredCount: number;

  /** Distinct recipients who opened at least once, not total opens. */
  @Column({ type: 'int', default: 0 })
  openedCount: number;

  @Column({ type: 'int', default: 0 })
  clickedCount: number;

  @Column({ type: 'int', default: 0 })
  bouncedCount: number;

  @Column({ type: 'int', default: 0 })
  complainedCount: number;

  @Column({ type: 'int', default: 0 })
  unsubscribedCount: number;

  @Column({ type: 'int', default: 0 })
  failedCount: number;

  @Column({ type: 'int', default: 0 })
  skippedCount: number;

  @OneToMany(() => EmailCampaignRecipient, (r) => r.campaign)
  recipients: EmailCampaignRecipient[];
}
