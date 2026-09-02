import { Column, Entity, Unique } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { LeadIngestRunStatus } from '../enums/lead.enum.js';

/**
 * One row per NRD file date we have tried to ingest.
 *
 * The unique constraint IS the concurrency control for double-ingest: the
 * claim is an INSERT ... ON CONFLICT whose WHERE refuses days already
 * completed, so two workers — or the hourly retry window re-firing — cannot
 * both process the same file. There is no application-level "is it running?"
 * check to race.
 */
@Entity('lead_ingest_runs')
@Unique('UQ_lead_ingest_runs_fileDate', ['fileDate'])
export class LeadIngestRun extends BaseEntity {
  /** The date named in the NRD file, not the date we fetched it. */
  @Column({ type: 'date' })
  fileDate: string;

  @Column({
    type: 'enum',
    enum: LeadIngestRunStatus,
    default: LeadIngestRunStatus.PENDING,
  })
  status: LeadIngestRunStatus;

  /** Lines in the file. */
  @Column({ type: 'int', default: 0 })
  totalDomains: number;

  /** Survived the TLD and lexical filters. */
  @Column({ type: 'int', default: 0 })
  matchedDomains: number;

  /** Actually new — not already present in `leads`. */
  @Column({ type: 'int', default: 0 })
  insertedDomains: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
