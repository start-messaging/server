import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LeadPipelineSettings } from './lead-pipeline-settings.entity.js';

/**
 * Read on every scheduled sweep and every drain slice; a short cache keeps
 * that off the database while still letting a panel change (including
 * "disable NOW") take effect within seconds even against a drain already
 * running.
 */
const CACHE_TTL_MS = 10_000;

/**
 * Every runtime knob the pipeline obeys: stored value, or the default.
 * One flat shape with identical keys across effective/stored/defaults, so
 * the panel's form logic is a single loop rather than per-field plumbing.
 */
export interface EffectivePipelineSettings {
  /** Auto-run gate for the daily NRD ingest. Manual runs bypass. */
  ingestEnabled: boolean;
  /** Auto-run gate for the hourly liveness probe sweep. Manual runs bypass. */
  livenessEnabled: boolean;
  /** Master switch for the automatic enrichment drain. Manual runs bypass. */
  enrichEnabled: boolean;
  enrichBatchPerSweep: number;
  enrichConcurrency: number;
  enrichRecrawlHours: number;
}

/** Same keys, nullable: null = "using the default" for that field. */
export type StoredPipelineSettings = {
  [K in keyof EffectivePipelineSettings]: EffectivePipelineSettings[K] | null;
};

/** The panel's view: what runs, what is stored, what the default would give. */
export interface SettingsView {
  effective: EffectivePipelineSettings;
  stored: StoredPipelineSettings;
  defaults: EffectivePipelineSettings;
}

@Injectable()
export class LeadsSettingsService {
  private readonly logger = new Logger(LeadsSettingsService.name);
  private cache: { row: LeadPipelineSettings; expiresAt: number } | null = null;

  constructor(
    @InjectRepository(LeadPipelineSettings)
    private readonly repo: Repository<LeadPipelineSettings>,
    private readonly config: ConfigService,
  ) {}

  /**
   * What every field falls back to while unset. Mostly the env baseline;
   * `ingestEnabled` is a code constant, because that gate has no env var.
   */
  private envDefaults(): EffectivePipelineSettings {
    return {
      // No env var behind this one: the ingest gate is operated from the panel
      // (lead_pipeline_settings.ingestEnabled) and nowhere else. False while
      // unset preserves exactly what the removed LEADS_INGEST_ENABLED was for
      // — the ingest fetches an external site daily and writes thousands of
      // rows, so a laptop pointed at the production database must not start
      // crawling WhoisDS on boot. Switching it on is a deliberate act, and now
      // it is an auditable one taken in the panel rather than a deploy.
      ingestEnabled: false,
      // Same as ingestEnabled: no env var behind it. The prober is operated
      // from the panel (lead_pipeline_settings.livenessEnabled), and off while
      // unset so no deployment starts probing other people's domains on boot.
      livenessEnabled: false,
      enrichEnabled: this.config.get<boolean>('leads.enrich.enabled') === true,
      enrichBatchPerSweep:
        this.config.get<number>('leads.enrich.batchPerSweep') ?? 500,
      enrichConcurrency:
        this.config.get<number>('leads.enrich.concurrency') ?? 4,
      enrichRecrawlHours:
        this.config.get<number>('leads.enrich.recrawlHours') ?? 48,
    };
  }

  /**
   * Returns the singleton row, creating it if missing. The migration seeds
   * it, but self-healing here means a fresh or partially-restored database
   * cannot take the pipeline down (same pattern as affiliate settings).
   */
  private async row(): Promise<LeadPipelineSettings> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.row;
    }
    let row = await this.repo.findOne({ where: { isSingleton: true } });
    if (!row) {
      this.logger.warn('lead_pipeline_settings row missing — creating it');
      // Two callers reach this branch together more often than it looks: the
      // enrich sweep fires on its schedule while an operator has the Pipeline
      // page open, and both read a missing row before either writes one. A
      // plain save() then made the loser die on
      // UQ_lead_pipeline_settings_singleton, and because effective() is the
      // first statement of GET /admin/leads/pipeline and GET
      // /admin/leads/settings, that surfaced as a 500 on the two pages an
      // operator opens to find out why the pipeline looks stuck — the healing
      // path failing exactly when it was needed. ON CONFLICT DO NOTHING makes
      // losing the race a no-op and the re-read below takes whichever insert
      // won, which is the house rule: the UNIQUE index is the guarantee, and
      // the code has to cooperate with it rather than be surprised by it.
      await this.repo
        .createQueryBuilder()
        .insert()
        .into(LeadPipelineSettings)
        .values({ isSingleton: true })
        .orIgnore()
        .execute();
      row = await this.repo.findOneOrFail({ where: { isSingleton: true } });
    }
    this.cache = { row, expiresAt: Date.now() + CACHE_TTL_MS };
    return row;
  }

  private stored(row: LeadPipelineSettings): StoredPipelineSettings {
    return {
      ingestEnabled: row.ingestEnabled,
      livenessEnabled: row.livenessEnabled,
      enrichEnabled: row.enrichEnabled,
      enrichBatchPerSweep: row.enrichBatchPerSweep,
      enrichConcurrency: row.enrichConcurrency,
      enrichRecrawlHours: row.enrichRecrawlHours,
    };
  }

  /** Stored-or-default per field — what the pipeline actually obeys. */
  async effective(): Promise<EffectivePipelineSettings> {
    const row = await this.row();
    const defaults = this.envDefaults();
    return {
      ingestEnabled: row.ingestEnabled ?? defaults.ingestEnabled,
      livenessEnabled: row.livenessEnabled ?? defaults.livenessEnabled,
      enrichEnabled: row.enrichEnabled ?? defaults.enrichEnabled,
      enrichBatchPerSweep:
        row.enrichBatchPerSweep ?? defaults.enrichBatchPerSweep,
      enrichConcurrency: row.enrichConcurrency ?? defaults.enrichConcurrency,
      enrichRecrawlHours: row.enrichRecrawlHours ?? defaults.enrichRecrawlHours,
    };
  }

  async view(): Promise<SettingsView> {
    const row = await this.row();
    return {
      effective: await this.effective(),
      stored: this.stored(row),
      defaults: this.envDefaults(),
    };
  }

  /**
   * Applies a partial update; a field explicitly set to null reverts to the
   * default (env for most fields, off for `ingestEnabled`). Only keys PRESENT in the patch are written — spreading the
   * DTO whole would smear `undefined` over stored values (the same
   * class-transformer trap the affiliate settings service documents).
   */
  async update(patch: Partial<StoredPipelineSettings>): Promise<SettingsView> {
    const current = await this.row();
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(changes).length > 0) {
      await this.repo.update({ id: current.id }, changes);
    }
    this.invalidate();
    return this.view();
  }

  /** Drops the cache so the next read reflects a write immediately. */
  invalidate(): void {
    this.cache = null;
  }
}
