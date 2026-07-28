import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';

export enum CommissionType {
  /** Commission is a percentage of the referred user's OTP spend. */
  PERCENT = 'percent',
  /** Commission is a fixed amount per delivered OTP. */
  FLAT = 'flat',
}

/**
 * Singleton row holding the affiliate programme's tunable rules.
 *
 * These live in the database rather than in env vars because the admin panel
 * has to change them at runtime, and because a rate change must not require a
 * redeploy. Every commission row snapshots the rate it was calculated with, so
 * editing these values never retroactively alters money already earned.
 */
@Entity('affiliate_settings')
export class AffiliateSettings extends BaseEntity {
  /**
   * Guard column. A unique constraint on a constant value is what makes this
   * table a true singleton — without it, a second settings row could appear
   * and which one "wins" becomes undefined.
   */
  @Column({ type: 'boolean', default: true, unique: true })
  isSingleton: boolean;

  /** Master switch. When false, no attribution or accrual happens at all. */
  @Column({ type: 'boolean', default: false })
  isEnabled: boolean;

  // ── Commission ─────────────────────────────────────────

  @Column({
    type: 'enum',
    enum: CommissionType,
    default: CommissionType.PERCENT,
  })
  defaultCommissionType: CommissionType;

  /**
   * Percentage (e.g. 10.0000 = 10%) when type is PERCENT, or rupees per
   * delivered OTP when type is FLAT. A partner row may override this.
   */
  @Column({ type: 'decimal', precision: 12, scale: 4, default: 10 })
  defaultCommissionRate: number;

  // ── Payout eligibility ─────────────────────────────────

  /** Referrals with >= 1 completed payment needed before any payout. */
  @Column({ type: 'int', default: 10 })
  minPaidReferrals: number;

  /** Unpaid earnings must reach this before a payout is raised. */
  @Column({ type: 'decimal', precision: 12, scale: 4, default: 1000 })
  minPayoutAmount: number;

  /** Day of month the payout run targets. */
  @Column({ type: 'int', default: 25 })
  payoutDayOfMonth: number;

  // ── Attribution ────────────────────────────────────────

  /** How long a referral cookie survives before attribution lapses. */
  @Column({ type: 'int', default: 60 })
  cookieDurationDays: number;

  /**
   * Commission is earned the moment an OTP is delivered, but is only written
   * to the ledger by a batch running on this interval. Crediting per message
   * would put every OTP send behind a write to the same partner row.
   */
  @Column({ type: 'int', default: 48 })
  accrualIntervalHours: number;

  /**
   * How far back the accrual batch re-scans on each run.
   *
   * A message can be created before a batch runs but only reach DELIVERED
   * after it, so scanning strictly "since the last run" would miss it forever.
   * Re-scanning a window catches those; the unique constraint on
   * partner_commissions.messageId makes the overlap harmless.
   */
  @Column({ type: 'int', default: 168 })
  accrualLookbackHours: number;
}
