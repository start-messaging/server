import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Partner } from './partner.entity.js';

/**
 * Daily click counters per partner, for the conversion funnel in the portal.
 *
 * Deliberately aggregated rather than one row per click. Click traffic is
 * unauthenticated and unbounded — a single partner posting a link somewhere
 * busy could write millions of rows nobody will ever read individually. One
 * upserted row per partner per day answers every question the funnel asks
 * ("clicks → signups → paid") at a fixed, tiny cost.
 */
@Index('IDX_referral_clicks_partnerId_date', ['partnerId', 'date'], {
  unique: true,
})
@Entity('referral_clicks')
export class ReferralClick {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  partnerId: string;

  @ManyToOne(() => Partner)
  @JoinColumn({ name: 'partnerId' })
  partner: Partner;

  /** IST calendar day, as `YYYY-MM-DD`. */
  @Column({ type: 'date' })
  date: string;

  @Column({ type: 'int', default: 0 })
  clicks: number;

  /** Distinct-ish visitors, counted by a short-lived dedupe key in Redis. */
  @Column({ type: 'int', default: 0 })
  uniqueClicks: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
