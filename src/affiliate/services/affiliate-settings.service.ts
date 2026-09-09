import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AffiliateSettings,
  CommissionType,
} from '../entities/affiliate-settings.entity.js';

/**
 * Settings are read on nearly every affiliate code path, including the
 * unauthenticated click endpoint. Caching for a short window keeps that off
 * the database without making an admin wait long to see a change take effect.
 */
const CACHE_TTL_MS = 30_000;

/** Plain shape with numerics coerced — Postgres returns `numeric` as string. */
export interface ResolvedSettings {
  id: string;
  isEnabled: boolean;
  defaultCommissionType: CommissionType;
  defaultCommissionRate: number;
  minPaidReferrals: number;
  minPayoutAmount: number;
  payoutDayOfMonth: number;
  cookieDurationDays: number;
  accrualIntervalHours: number;
  accrualLookbackHours: number;
  lastAccrualAt: Date | null;
}

@Injectable()
export class AffiliateSettingsService {
  private readonly logger = new Logger(AffiliateSettingsService.name);
  private cache: { value: ResolvedSettings; expiresAt: number } | null = null;

  constructor(
    @InjectRepository(AffiliateSettings)
    private readonly repo: Repository<AffiliateSettings>,
  ) {}

  /**
   * Returns the singleton, creating it if the row is somehow missing.
   *
   * The migration seeds it, but self-healing here means a fresh database or a
   * partially-restored one cannot take the whole affiliate module down.
   */
  async get(): Promise<ResolvedSettings> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    let row = await this.repo.findOne({ where: { isSingleton: true } });

    if (!row) {
      this.logger.warn('affiliate_settings row missing — creating defaults');
      // Same race, same fix as LeadsSettingsService.row(): the accrual and
      // payout schedulers call get() on their own timers while the panel is
      // being used, so two callers can both find the row missing and both
      // insert. save() made the loser throw on the unique index and take the
      // whole affiliate module down with it — the opposite of the self-healing
      // this branch exists for. The index stays the guarantee; DO NOTHING plus
      // a re-read is how the code cooperates with it.
      await this.repo
        .createQueryBuilder()
        .insert()
        .into(AffiliateSettings)
        .values({ isSingleton: true, isEnabled: false })
        .orIgnore()
        .execute();
      row = await this.repo.findOneOrFail({ where: { isSingleton: true } });
    }

    const value = this.toResolved(row);
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  async update(patch: Partial<AffiliateSettings>): Promise<ResolvedSettings> {
    const current = await this.repo.findOneOrFail({
      where: { isSingleton: true },
    });

    // isSingleton is the uniqueness guard, never something a caller may set.
    delete patch.isSingleton;
    // lastAccrualAt is the accrual watermark, owned by the accrual job.
    delete patch.lastAccrualAt;

    // Keys explicitly present in the patch, dropping the ones the DTO declares
    // but the request omitted.
    //
    // A plain `{ ...current, ...patch }` is wrong here: class-transformer
    // materialises every declared optional property, so a PATCH carrying only
    // `accrualLookbackHours` still spreads `accrualIntervalHours: undefined`
    // over the stored 48. The invariant then compares `12 < undefined`, which
    // is false rather than an error, so the check waved through exactly the
    // inversion it exists to stop and the database constraint rejected it as a
    // 500 instead of a 400.
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<AffiliateSettings>;

    this.assertInvariants({ ...current, ...changes });

    await this.repo.update({ id: current.id }, changes);
    this.invalidate();
    return this.get();
  }

  /**
   * Rejects combinations that are individually valid but wrong together.
   *
   * Field-level decorators cannot catch these: a PATCH may carry only one of
   * the pair, so the check has to run against the merged row. Each of these
   * silently loses money rather than erroring at run time, which is why they
   * are refused at the point of entry instead of clamped later.
   */
  private assertInvariants(next: AffiliateSettings): void {
    // The accrual re-scans `accrualLookbackHours` of message history on every
    // run. A lookback shorter than the gap between runs leaves the difference
    // permanently unscanned — those commissions are never accrued, and nothing
    // revisits them.
    if (next.accrualLookbackHours < next.accrualIntervalHours) {
      throw new BadRequestException(
        `accrualLookbackHours (${next.accrualLookbackHours}) must be at least ` +
          `accrualIntervalHours (${next.accrualIntervalHours}); a shorter ` +
          `lookback leaves messages between runs permanently unaccrued.`,
      );
    }
  }

  /** Drops the cache so the next read reflects a write immediately. */
  invalidate(): void {
    this.cache = null;
  }

  private toResolved(row: AffiliateSettings): ResolvedSettings {
    return {
      id: row.id,
      isEnabled: row.isEnabled,
      defaultCommissionType: row.defaultCommissionType,
      defaultCommissionRate: Number(row.defaultCommissionRate),
      minPaidReferrals: row.minPaidReferrals,
      minPayoutAmount: Number(row.minPayoutAmount),
      payoutDayOfMonth: row.payoutDayOfMonth,
      cookieDurationDays: row.cookieDurationDays,
      accrualIntervalHours: row.accrualIntervalHours,
      accrualLookbackHours: row.accrualLookbackHours,
      lastAccrualAt: row.lastAccrualAt,
    };
  }

  /**
   * Advances the accrual watermark. Called by the accrual job only, with the
   * time that run *started* — anything delivered while it was running has to
   * stay inside the next window.
   */
  async recordAccrualRun(startedAt: Date): Promise<void> {
    await this.repo.update({ isSingleton: true }, { lastAccrualAt: startedAt });
    this.invalidate();
  }
}
