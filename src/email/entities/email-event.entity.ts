import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';

/**
 * Normalised provider event names.
 *
 * Mailgun spells these `accepted`, `delivered`, `opened`, `clicked`, `failed`,
 * `complained`, `unsubscribed`. Keeping our own list means a provider swap
 * changes one mapping function rather than every query that reads this table.
 */
export enum EmailEventType {
  ACCEPTED = 'accepted',
  DELIVERED = 'delivered',
  OPENED = 'opened',
  CLICKED = 'clicked',
  BOUNCED = 'bounced',
  COMPLAINED = 'complained',
  UNSUBSCRIBED = 'unsubscribed',
  FAILED = 'failed',
}

/**
 * Append-only log of everything the provider told us about a campaign.
 *
 * The recipient row holds the current state; this holds how it got there —
 * which is what the "opened 4 times, last from Mumbai on Tuesday" panel and
 * the engagement-over-time chart are built from.
 *
 * Never updated after insert. Webhook redelivery is deduplicated on
 * `providerEventId`, so replaying a day of events is a no-op rather than a
 * doubling of every open count.
 */
@Index('IDX_email_events_campaign_type', ['campaignId', 'event'])
@Index('IDX_email_events_recipient', ['recipientId'])
@Index('IDX_email_events_occurredAt', ['occurredAt'])
@Entity('email_events')
export class EmailEvent extends BaseEntity {
  /** Null when a webhook arrives for a message we no longer recognise. */
  @Column({ type: 'uuid', nullable: true })
  campaignId: string | null;

  @Column({ type: 'uuid', nullable: true })
  recipientId: string | null;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'enum', enum: EmailEventType })
  event: EmailEventType;

  /**
   * Provider's own event id, unique per event.
   *
   * Mailgun retries a webhook for up to 8 hours until it gets a 200, so the
   * same `opened` event arrives repeatedly whenever a deploy or a slow query
   * makes us time out. A unique index here turns those retries into a
   * conflict we can swallow.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerEventId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerMessageId: string | null;

  /** Which link was clicked. Only set for `CLICKED`. */
  @Column({ type: 'text', nullable: true })
  url: string | null;

  /** Provider's reason string for a bounce or failure. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  city: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  country: string | null;

  /** `desktop` | `mobile` | `tablet` | `webmail`, as reported. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  deviceType: string | null;

  /** Reading client, e.g. "Gmail", "Apple Mail". */
  @Column({ type: 'varchar', length: 120, nullable: true })
  clientName: string | null;

  /**
   * When it happened at the provider, not when we stored it.
   *
   * Mailgun buffers and retries, so `createdAt` can trail the real event by
   * hours — charting on it would draw a spike at the moment of recovery
   * instead of when people actually read the mail.
   */
  @Column({ type: 'timestamptz' })
  occurredAt: Date;

  /**
   * Full payload, for diagnosing anything this schema did not anticipate.
   *
   * `any` rather than `unknown` in the value position to match the other jsonb
   * columns in this codebase: TypeORM's `QueryDeepPartialEntity` cannot narrow
   * an index signature of `unknown`, and every insert would need a cast.
   */
  @Column({ type: 'jsonb', nullable: true })
  raw: Record<string, any> | null;
}
