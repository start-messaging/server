import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { EmailSuppressionReason } from '../enums/email-suppression-reason.enum.js';

/**
 * Addresses that must never be mailed again.
 *
 * Checked twice on purpose — once when a campaign's recipient list is built,
 * and again inside the send worker immediately before the API call. The list
 * for a large campaign is materialised minutes or hours before the last job
 * runs, and someone who unsubscribes from the first thousand emails would
 * otherwise still be sitting in the queue for the remaining nineteen.
 *
 * Rows are never hard-deleted by the system: "they unsubscribed and we forgot"
 * is the one failure here with legal weight. An admin can lift a suppression
 * explicitly, which soft-deletes the row and leaves the history intact.
 */
@Index('UQ_email_suppressions_email', ['email'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Entity('email_suppressions')
export class EmailSuppression extends BaseEntity {
  /** Stored lower-cased; all lookups normalise the same way. */
  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'enum', enum: EmailSuppressionReason })
  reason: EmailSuppressionReason;

  /** The campaign that triggered it, when there was one. */
  @Column({ type: 'uuid', nullable: true })
  campaignId: string | null;

  /** Free-text context for a manual entry. */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** Admin who added it manually. Null when the provider caused it. */
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;
}
