import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { LeadOutreachEventType } from '../enums/lead.enum.js';
import { Lead } from './lead.entity.js';

/**
 * Append-only history of what happened to outreach for one lead.
 *
 * The lead row carries the latest timestamps for cheap list rendering; this
 * table keeps every occurrence, because "opened three times over two weeks,
 * then clicked" and "opened once" argue for different follow-ups.
 */
@Entity('lead_outreach_events')
export class LeadOutreachEvent extends BaseEntity {
  @Index('IDX_lead_outreach_events_leadId')
  @Column({ type: 'uuid' })
  leadId: string;

  @ManyToOne(() => Lead, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'leadId' })
  lead: Lead;

  @Column({ type: 'enum', enum: LeadOutreachEventType })
  type: LeadOutreachEventType;

  /** Which transport reported it — 'smtp', 'console', or first-party 'tracker'. */
  @Column({ type: 'varchar', length: 40 })
  provider: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  occurredAt: Date;
}
