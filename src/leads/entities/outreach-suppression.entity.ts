import { Column, Entity, Unique } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { SuppressionReason } from '../enums/lead.enum.js';

/**
 * Addresses cold outreach must never touch again.
 *
 * Stored lowercased, and unique on the email rather than the lead: one person
 * can own many domains, and unsubscribing from one mail has to silence all of
 * them. Checked before every queue-outreach, and written by the unsubscribe
 * endpoint — CAN-SPAM gives ten business days to honour an opt-out; a table
 * the send path cannot skip honours it immediately.
 */
@Entity('outreach_suppressions')
@Unique('UQ_outreach_suppressions_email', ['email'])
export class OutreachSuppression extends BaseEntity {
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({
    type: 'enum',
    enum: SuppressionReason,
    default: SuppressionReason.MANUAL,
  })
  reason: SuppressionReason;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
