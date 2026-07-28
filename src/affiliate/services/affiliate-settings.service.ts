import { Injectable, Logger } from '@nestjs/common';
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
      row = await this.repo.save(
        this.repo.create({ isSingleton: true, isEnabled: false }),
      );
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

    await this.repo.update({ id: current.id }, patch);
    this.invalidate();
    return this.get();
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
    };
  }
}
