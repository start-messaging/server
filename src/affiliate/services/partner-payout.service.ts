import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AffiliateSettingsService } from './affiliate-settings.service.js';
import { istDayStart } from '../../common/utils/date.util.js';
import { PartnerPayout } from '../entities/partner-payout.entity.js';
import { Partner } from '../entities/partner.entity.js';

/** Why a partner was passed over, so the portal can explain the wait. */
export type PayoutSkipReason =
  | 'not_enough_paid_referrals'
  | 'below_minimum_amount'
  | 'no_unpaid_earnings'
  | 'already_paid_this_period';

export interface PartnerPayoutEligibility {
  partnerId: string;
  qualifiedReferrals: number;
  requiredReferrals: number;
  unpaidEarnings: number;
  minPayoutAmount: number;
  isEligible: boolean;
  reason?: PayoutSkipReason;
}

export interface PayoutRunResult {
  skipped: boolean;
  reason?: string;
  periodKey: string;
  payoutsCreated: number;
  totalAmount: number;
  considered: number;
  skippedPartners: Record<PayoutSkipReason, number>;
  durationMs: number;
}

@Injectable()
export class PartnerPayoutService {
  private readonly logger = new Logger(PartnerPayoutService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settingsService: AffiliateSettingsService,
  ) {}

  /** `YYYY-MM` for the IST month a run belongs to. */
  private periodKeyFor(date: Date): string {
    const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Whether a payout would be raised for this partner right now, and if not,
   * exactly what is missing. Powers the "progress to payout" panel in the
   * portal, and is the same predicate the run itself uses so the two can never
   * disagree.
   */
  async getEligibility(partnerId: string): Promise<PartnerPayoutEligibility> {
    const settings = await this.settingsService.get();

    const [row] = await this.dataSource.query<
      { qualified: string; unpaid: string }[]
    >(
      `
      SELECT
        (SELECT COUNT(*) FROM "referrals" r
          WHERE r."partnerId" = $1
            AND r."status" = 'qualified'
            AND r."deletedAt" IS NULL) AS qualified,
        (SELECT COALESCE(SUM(c."amount"), 0) FROM "partner_commissions" c
          WHERE c."partnerId" = $1
            AND c."status" = 'accrued'
            AND c."deletedAt" IS NULL) AS unpaid
      `,
      [partnerId],
    );

    const qualifiedReferrals = Number(row?.qualified ?? 0);
    const unpaidEarnings = Number(row?.unpaid ?? 0);

    let reason: PayoutSkipReason | undefined;
    if (unpaidEarnings <= 0) {
      reason = 'no_unpaid_earnings';
    } else if (qualifiedReferrals < settings.minPaidReferrals) {
      reason = 'not_enough_paid_referrals';
    } else if (unpaidEarnings < settings.minPayoutAmount) {
      reason = 'below_minimum_amount';
    }

    return {
      partnerId,
      qualifiedReferrals,
      requiredReferrals: settings.minPaidReferrals,
      unpaidEarnings,
      minPayoutAmount: settings.minPayoutAmount,
      isEligible: !reason,
      reason,
    };
  }

  /**
   * Raises payouts for every eligible partner.
   *
   * Each partner is settled in its own transaction. One partner's bad data
   * (a null payout method, a constraint violation) must not roll back money
   * already settled for everyone else in the same run.
   *
   * Re-running on the same day is safe: `UQ_partner_payouts_partnerId_periodKey`
   * rejects a second payout for the same cycle, and the commissions swept into
   * the first one are no longer `accrued` so they cannot be swept again.
   */
  async runPayouts(
    options: { force?: boolean } = {},
  ): Promise<PayoutRunResult> {
    const startedAt = Date.now();
    const now = new Date();
    const periodKey = this.periodKeyFor(now);
    const settings = await this.settingsService.get();

    const skippedPartners: Record<PayoutSkipReason, number> = {
      not_enough_paid_referrals: 0,
      below_minimum_amount: 0,
      no_unpaid_earnings: 0,
      already_paid_this_period: 0,
    };

    const base = {
      periodKey,
      payoutsCreated: 0,
      totalAmount: 0,
      considered: 0,
      skippedPartners,
      durationMs: Date.now() - startedAt,
    };

    if (!settings.isEnabled) {
      return {
        ...base,
        skipped: true,
        reason: 'Affiliate programme is disabled',
      };
    }

    // The scheduler fires daily; only the configured day of month actually
    // pays. Checking here (rather than encoding the day in a cron expression)
    // means an admin changing the day in settings takes effect immediately,
    // without re-registering a repeatable job.
    const istDay = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCDate();
    if (!options.force && istDay !== settings.payoutDayOfMonth) {
      return {
        ...base,
        skipped: true,
        reason: `Not payout day (IST day ${istDay}, configured ${settings.payoutDayOfMonth})`,
      };
    }

    // Only partners who could possibly qualify are loaded, so the run does not
    // walk the entire partner table once the programme has many sign-ups.
    const candidates = await this.dataSource.query<{ id: string }[]>(
      `
      SELECT p."id"
      FROM "partners" p
      WHERE p."deletedAt" IS NULL
        AND p."status" = 'active'
        AND p."unpaidEarnings" >= $1
        AND (
          SELECT COUNT(*) FROM "referrals" r
          WHERE r."partnerId" = p."id"
            AND r."status" = 'qualified'
            AND r."deletedAt" IS NULL
        ) >= $2
      ORDER BY p."id"
      `,
      [settings.minPayoutAmount, settings.minPaidReferrals],
    );

    let payoutsCreated = 0;
    let totalAmount = 0;

    for (const { id: partnerId } of candidates) {
      try {
        const amount = await this.settlePartner(partnerId, periodKey, now);
        if (amount === null) {
          skippedPartners.already_paid_this_period += 1;
          continue;
        }
        payoutsCreated += 1;
        totalAmount += amount;
      } catch (err) {
        // Isolated on purpose — log and continue so one partner cannot stall
        // the whole month's settlement.
        this.logger.error(
          `Payout failed for partner ${partnerId}: ${(err as Error).message}`,
        );
      }
    }

    const result: PayoutRunResult = {
      ...base,
      skipped: false,
      considered: candidates.length,
      payoutsCreated,
      totalAmount,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `Payout run ${periodKey}: ${payoutsCreated}/${candidates.length} partners settled, ₹${totalAmount.toFixed(2)}`,
    );

    return result;
  }

  /**
   * Settles one partner inside a single transaction.
   *
   * Returns the amount paid, or null when a payout for this cycle already
   * exists (a retry).
   */
  private async settlePartner(
    partnerId: string,
    periodKey: string,
    now: Date,
  ): Promise<number | null> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // Lock the partner row for the duration. Without it, a concurrent
      // accrual could add commissions between the sum and the sweep, and the
      // cached totals would end up disagreeing with the ledger.
      const [partner] = await manager.query<
        (Partner & { unpaidEarnings: string })[]
      >(`SELECT * FROM "partners" WHERE "id" = $1 FOR UPDATE`, [partnerId]);

      if (!partner) return null;

      const existing = await manager
        .getRepository(PartnerPayout)
        .findOne({ where: { partnerId, periodKey } });
      if (existing) return null;

      const [totals] = await manager.query<
        { total: string; cnt: string; first_earned: Date | null }[]
      >(
        `
        SELECT COALESCE(SUM("amount"), 0) AS total,
               COUNT(*) AS cnt,
               MIN("earnedAt") AS first_earned
        FROM "partner_commissions"
        WHERE "partnerId" = $1 AND "status" = 'accrued' AND "deletedAt" IS NULL
        `,
        [partnerId],
      );

      const amount = Number(totals?.total ?? 0);
      const commissionCount = Number(totals?.cnt ?? 0);
      if (amount <= 0 || commissionCount === 0) return null;

      const [{ qualified }] = await manager.query<{ qualified: string }[]>(
        `SELECT COUNT(*) AS qualified FROM "referrals"
          WHERE "partnerId" = $1 AND "status" = 'qualified' AND "deletedAt" IS NULL`,
        [partnerId],
      );

      const payout = await manager.getRepository(PartnerPayout).save(
        manager.getRepository(PartnerPayout).create({
          partnerId,
          periodKey,
          periodStart: totals?.first_earned ?? istDayStart(),
          periodEnd: now,
          amount,
          commissionCount,
          qualifiedReferralCount: Number(qualified),
          // Snapshotted so later edits to the partner's bank details never
          // rewrite where past money was actually sent.
          payoutMethod: partner.payoutMethod,
          payoutAccountName: partner.bankAccountName ?? null,
          payoutAccountRef: this.maskAccount(partner),
        }),
      );

      // Claim exactly the rows that were summed.
      //
      // No extra guard is needed against a commission arriving between the SUM
      // and this UPDATE: an accrual running concurrently has to take the same
      // partner row lock to update the cached totals, so its inserts stay
      // uncommitted — and therefore invisible to this transaction — until it
      // does. Both statements see a consistent set of `accrued` rows.
      // Wrapped in a CTE so the statement ends in a SELECT. TypeORM returns
      // `[rows, affectedCount]` for a bare `UPDATE … RETURNING`, which would
      // make the count below always 2 and fail the check on every payout.
      const [claimed] = await manager.query<{ count: string }[]>(
        `WITH claimed AS (
           UPDATE "partner_commissions"
              SET "status" = 'paid', "payoutId" = $2, "updatedAt" = now()
            WHERE "partnerId" = $1
              AND "status" = 'accrued'
              AND "deletedAt" IS NULL
          RETURNING "id"
         )
         SELECT COUNT(*)::int AS count FROM claimed`,
        [partnerId, payout.id],
      );

      if (Number(claimed?.count ?? 0) !== commissionCount) {
        // Cannot happen given the locking above; if it ever does, the payout
        // amount and the rows behind it have diverged and the whole
        // transaction must be abandoned rather than pay an unverified figure.
        throw new Error(
          `Payout ${payout.id}: claimed ${claimed?.count} commissions but summed ${commissionCount}`,
        );
      }

      await manager.query(
        `UPDATE "partners"
            SET "unpaidEarnings" = "unpaidEarnings" - $2,
                "paidEarnings"   = "paidEarnings"   + $2,
                "updatedAt"      = now()
          WHERE "id" = $1`,
        [partnerId, amount],
      );

      return amount;
    });
  }

  /** Last four digits only — the payout record never duplicates full details. */
  private maskAccount(partner: Partner): string | null {
    const raw = partner.upiId ?? partner.bankAccountNumber;
    if (!raw) return null;
    return raw.length <= 4 ? `••••${raw}` : `••••${raw.slice(-4)}`;
  }
}
