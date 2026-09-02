import { Check, Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';

/**
 * Singleton row of admin-tunable enrichment knobs, same pattern as
 * affiliate_settings: these live in the database because the panel has to
 * change them at runtime — turning the crawler off, resizing a batch or
 * moving the re-crawl window must not require a redeploy.
 *
 * Every column is NULLABLE, and NULL means "use the env default"
 * (LEADS_ENRICH_* in configuration.ts). That keeps the env file the source
 * of an environment's baseline — a fresh row overrides nothing — while a
 * stored value always wins once an admin sets one. PATCHing a field back to
 * null returns it to the env default.
 *
 * Ranges are CHECK-enforced here, not just in the DTO — a concurrency of
 * 5000 is wrong whatever surface writes it.
 */
@Entity('lead_pipeline_settings')
@Check('CHK_lead_pipeline_settings_batch', '"enrichBatchPerSweep" BETWEEN 1 AND 10000')
@Check('CHK_lead_pipeline_settings_concurrency', '"enrichConcurrency" BETWEEN 1 AND 20')
@Check('CHK_lead_pipeline_settings_recrawl', '"enrichRecrawlHours" BETWEEN 1 AND 8760')
export class LeadPipelineSettings extends BaseEntity {
  /**
   * Guard column. A unique constraint on a constant value is what makes this
   * table a true singleton — without it, a second settings row could appear
   * and which one "wins" becomes undefined.
   */
  @Column({ type: 'boolean', default: true, unique: true })
  isSingleton: boolean;

  /**
   * Auto-run gate for the daily NRD ingest. All three stage gates live here
   * (team decision: gates are operated from the panel, not the env file) —
   * every schedule is always registered and checks its gate at fire time,
   * which is what makes a panel toggle effective in both directions without
   * a redeploy. Manual "run now" always bypasses.
   */
  @Column({ type: 'boolean', nullable: true })
  ingestEnabled: boolean | null;

  /** Auto-run gate for the hourly liveness probe sweep. */
  @Column({ type: 'boolean', nullable: true })
  livenessEnabled: boolean | null;

  /** Master switch for the automatic drain; manual runs bypass it. */
  @Column({ type: 'boolean', nullable: true })
  enrichEnabled: boolean | null;

  /** Leads claimed per drain slice (the drain loops until nothing claims). */
  @Column({ type: 'int', nullable: true })
  enrichBatchPerSweep: number | null;

  /** Sites crawled at once inside the drain. */
  @Column({ type: 'int', nullable: true })
  enrichConcurrency: number | null;

  /**
   * The re-crawl window: an enriched/no_contact lead whose last crawl is
   * older than this many hours re-enters the drain, so every live site is
   * re-read on this cycle — sites change, contacts appear.
   */
  @Column({ type: 'int', nullable: true })
  enrichRecrawlHours: number | null;
}
