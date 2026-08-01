import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AffiliateSettingsService } from './affiliate-settings.service.js';

export interface AccrualRunResult {
  skipped: boolean;
  reason?: string;
  /** Referrals newly marked qualified by the sweep. */
  newlyQualified: number;
  /** Commission rows created this run. */
  commissionsCreated: number;
  totalAccrued: number;
  partnersCredited: number;
  windowStart: Date | null;
  durationMs: number;
}

@Injectable()
export class CommissionAccrualService {
  private readonly logger = new Logger(CommissionAccrualService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settingsService: AffiliateSettingsService,
  ) {}

  /**
   * Credits partners for OTPs their referrals have consumed.
   *
   * Runs on a schedule (every `accrualIntervalHours`) rather than inline with
   * each delivered message. Crediting per message would serialise every OTP
   * send behind a write to the referring partner's row — the same write
   * amplification that makes a shared counter a bottleneck.
   *
   * The whole thing is one SQL statement on purpose:
   *
   *  - **Exactness.** Money is computed in Postgres `numeric`, not JavaScript
   *    floats. `0.25 * 7 / 100` in JS is 0.017500000000000002; in numeric it
   *    is exact.
   *  - **Idempotency.** `ON CONFLICT (messageId) DO NOTHING` means a retry, an
   *    overlapping window, or two workers racing can never pay twice for one
   *    OTP. The database enforces it, not application logic.
   *  - **Atomicity.** Inserting the ledger rows and bumping the partner's
   *    cached totals happen in a single statement, so the cache cannot drift
   *    from the ledger if the process dies mid-run.
   *  - **Scale.** Cost is independent of how many messages are in the window;
   *    it does not stream rows into Node to loop over them.
   */
  async runAccrual(): Promise<AccrualRunResult> {
    const startedAt = Date.now();
    const settings = await this.settingsService.get();

    if (!settings.isEnabled) {
      // The watermark advances even though nothing is accrued. Being switched
      // off is a decision, not an outage: if the watermark froze here, the
      // window would widen across the whole disabled period and re-enabling
      // would retroactively pay every OTP delivered while the programme was
      // deliberately stopped — exactly the money the business chose not to owe.
      // Leaving it frozen is worse than the gap the watermark exists to close.
      await this.settingsService.recordAccrualRun(new Date(startedAt));

      return {
        skipped: true,
        reason: 'Affiliate programme is disabled',
        newlyQualified: 0,
        commissionsCreated: 0,
        totalAccrued: 0,
        partnersCredited: 0,
        windowStart: null,
        durationMs: Date.now() - startedAt,
      };
    }

    // Re-scan a window rather than "everything since the last run". A message
    // can be created before a run and only reach DELIVERED after it; a strict
    // watermark would skip it permanently. Overlap is free because of the
    // unique constraint.
    //
    // The watermark is used only to *widen* that window, never to narrow it:
    // if the last successful run is further back than the lookback — the
    // worker was down, Redis was unreachable, the interval was raised above
    // the lookback — the gap is still scanned. Without this, messages
    // delivered during an outage longer than `accrualLookbackHours` fall
    // outside every future window and are never paid.
    const lookbackStart = new Date(
      Date.now() - settings.accrualLookbackHours * 60 * 60 * 1000,
    );
    const watermark = settings.lastAccrualAt
      ? new Date(settings.lastAccrualAt)
      : null;
    const windowStart =
      watermark && watermark < lookbackStart ? watermark : lookbackStart;

    if (watermark && watermark < lookbackStart) {
      this.logger.warn(
        `Accrual window widened to the watermark (${watermark.toISOString()}): ` +
          `the last successful run is older than the ${settings.accrualLookbackHours}h lookback.`,
      );
    }

    const runStartedAt = new Date(startedAt);
    const newlyQualified = await this.sweepQualifiedReferrals();
    const accrual = await this.accrueCommissions(windowStart);

    // Only after the scan succeeded — a throw above must leave the watermark
    // where it was so the next run re-covers the same ground.
    await this.settingsService.recordAccrualRun(runStartedAt);

    const result: AccrualRunResult = {
      skipped: false,
      newlyQualified,
      ...accrual,
      windowStart,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `Accrual complete: ${result.commissionsCreated} commissions ` +
        `(₹${result.totalAccrued.toFixed(4)}) across ${result.partnersCredited} partners; ` +
        `${newlyQualified} referrals newly qualified; ${result.durationMs}ms`,
    );

    return result;
  }

  /**
   * Promotes referrals to `qualified` once the referred user has paid.
   *
   * Driven off the payments table rather than a hook inside the payment flow,
   * so a missed event or a payment completed by a gateway webhook during a
   * deploy still gets picked up on the next run. Self-healing beats
   * event-perfect for something that gates money.
   */
  private async sweepQualifiedReferrals(): Promise<number> {
    // Wrapped so the statement is a SELECT: TypeORM's `query()` returns
    // `[rows, affectedCount]` for a bare `UPDATE … RETURNING`, and reading
    // `.length` off that always gives 2 regardless of how many rows changed.
    const rows = await this.dataSource.query<{ count: string }[]>(`
      WITH updated AS (
        UPDATE "referrals" r
        SET "status" = 'qualified',
            "qualifiedAt" = firstPaid.paid_at,
            "updatedAt" = now()
        FROM (
          SELECT "userId", MIN("createdAt") AS paid_at
          FROM "payments"
          WHERE "status" = 'completed' AND "deletedAt" IS NULL
          GROUP BY "userId"
        ) AS firstPaid
        WHERE r."userId" = firstPaid."userId"
          AND r."status" = 'pending'
          AND r."deletedAt" IS NULL
        RETURNING r."id"
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    return Number(rows[0]?.count ?? 0);
  }

  private async accrueCommissions(windowStart: Date): Promise<{
    commissionsCreated: number;
    totalAccrued: number;
    partnersCredited: number;
  }> {
    const rows = await this.dataSource.query<
      { id: string; credited: string; created: string }[]
    >(
      `
      WITH inserted AS (
        INSERT INTO "partner_commissions" (
          "partnerId", "referralId", "userId", "messageId",
          "baseAmount", "rateType", "rateValue", "amount",
          "status", "earnedAt"
        )
        SELECT
          r."partnerId",
          r."id",
          m."userId",
          m."id",
          m."costAmount",
          eff.rate_type,
          eff.rate_value,
          CASE
            WHEN eff.rate_type = 'percent'
              THEN ROUND(m."costAmount" * eff.rate_value / 100, 4)
            ELSE ROUND(eff.rate_value, 4)
          END,
          'accrued',
          COALESCE(m."deliveredAt", m."updatedAt")
        FROM "messages" m
        JOIN "referrals" r
          ON r."userId" = m."userId"
         AND r."deletedAt" IS NULL
         AND r."status" <> 'blocked'
        JOIN "partners" p
          ON p."id" = r."partnerId"
         AND p."deletedAt" IS NULL
         AND p."status" = 'active'
        -- isEnabled is re-checked here as well as in the caller. The caller
        -- reads it through a 30s cache, so a run that started just before the
        -- programme was switched off would otherwise insert against a stale
        -- flag; the database sees the committed value.
        CROSS JOIN "affiliate_settings" s
        CROSS JOIN LATERAL (
          SELECT
            -- The per-partner override and the global default are different
            -- enum types, so they are reconciled through text before being
            -- cast to the type the ledger column expects.
            COALESCE(p."commissionType"::text, s."defaultCommissionType"::text)
              ::"partner_commissions_ratetype_enum" AS rate_type,
            COALESCE(p."commissionRate", s."defaultCommissionRate") AS rate_value
        ) AS eff
        WHERE s."isSingleton" = true
          AND s."isEnabled" = true
          AND m."status" = 'delivered'
          AND m."deletedAt" IS NULL
          AND m."costAmount" > 0
          AND m."updatedAt" >= $1
        ON CONFLICT ("messageId") DO NOTHING
        RETURNING "partnerId", "amount"
      ),
      totals AS (
        SELECT "partnerId", SUM("amount") AS total, COUNT(*) AS cnt
        FROM inserted
        GROUP BY "partnerId"
      ),
      credited AS (
        UPDATE "partners" p
        SET "lifetimeEarnings" = p."lifetimeEarnings" + t.total,
            "unpaidEarnings"   = p."unpaidEarnings"   + t.total,
            "updatedAt"        = now()
        FROM totals t
        WHERE p."id" = t."partnerId"
        RETURNING p."id", t.total AS credited, t.cnt AS created
      )
      -- Ends in a SELECT so TypeORM hands back the rows. A statement ending in
      -- UPDATE ... RETURNING comes back as [rows, affectedCount] instead,
      -- which silently turns every count below into NaN.
      SELECT "id", credited, created FROM credited
      `,
      [windowStart],
    );

    return {
      partnersCredited: rows.length,
      commissionsCreated: rows.reduce((n, r) => n + Number(r.created), 0),
      totalAccrued: rows.reduce((n, r) => n + Number(r.credited), 0),
    };
  }

  /**
   * Recomputes the cached totals on `partners` from the commission ledger.
   *
   * The ledger is the source of truth; the columns on `partners` exist only so
   * the dashboard does not aggregate on every page load. This rebuilds them,
   * and returns the partners whose cache had drifted — a non-empty result is a
   * bug worth investigating, not something to silently repair and forget.
   */
  async reconcilePartnerTotals(): Promise<
    { partnerId: string; before: number; after: number }[]
  > {
    const drifted = await this.dataSource.query<
      { id: string; before: string; after: string }[]
    >(`
      WITH ledger AS (
        SELECT
          p."id",
          -- The cached value is captured here, before the UPDATE. Reading it
          -- from RETURNING would report the value just written, since
          -- RETURNING sees the post-update row.
          p."unpaidEarnings" AS cached_unpaid,
          COALESCE(SUM(c."amount") FILTER (
            WHERE c."status" IN ('accrued', 'paid')), 0) AS lifetime,
          COALESCE(SUM(c."amount") FILTER (
            WHERE c."status" = 'accrued'), 0) AS unpaid,
          COALESCE(SUM(c."amount") FILTER (
            WHERE c."status" = 'paid'), 0) AS paid
        FROM "partners" p
        LEFT JOIN "partner_commissions" c
          ON c."partnerId" = p."id" AND c."deletedAt" IS NULL
        WHERE p."deletedAt" IS NULL
        GROUP BY p."id"
      ),
      corrected AS (
        UPDATE "partners" p
        SET "lifetimeEarnings" = l.lifetime,
            "unpaidEarnings"   = l.unpaid,
            "paidEarnings"     = l.paid,
            "updatedAt"        = now()
        FROM ledger l
        WHERE p."id" = l."id"
          AND (p."lifetimeEarnings" <> l.lifetime
            OR p."unpaidEarnings"   <> l.unpaid
            OR p."paidEarnings"     <> l.paid)
        RETURNING p."id", l.cached_unpaid, l.unpaid
      )
      SELECT "id", cached_unpaid AS before, unpaid AS after FROM corrected
    `);

    if (drifted.length > 0) {
      this.logger.warn(
        `Reconciliation corrected cached totals for ${drifted.length} partner(s)`,
      );
    }

    return drifted.map((r) => ({
      partnerId: r.id,
      before: Number(r.before),
      after: Number(r.after),
    }));
  }
}
