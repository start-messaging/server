import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the growth/leads pipeline schema.
 *
 * The pipeline is moving to its own service. It never belonged in the product
 * database: there was not a single foreign key between these tables and any
 * product table, no code imported across the boundary in either direction, and
 * the prospect table had grown to 479,295 rows against 396 customers — roughly
 * 1,200 rows of cold-outreach data for every paying account, dragged along by
 * every backup, restore and migration rehearsal.
 *
 * The public, unauthenticated tracking routes (/t/o, /t/c, /t/u) went with it,
 * which is the part that most wanted to leave: crawl-facing endpoints sharing a
 * host with the payments API.
 *
 * DATA: archived before this ran, to db-dump/leads-archive-2026-09-09.sql.gz —
 * verified to contain all 479,295 lead rows plus the ingest runs and the
 * settings singleton. That archive, not this migration, is the restore path.
 *
 * Ordering: lead_outreach_events first — it is the only FK in the set
 * (lead_outreach_events.leadId -> leads), and it is internal to the group.
 */
export class DropLeadsPipeline1788000000000 implements MigrationInterface {
  name = 'DropLeadsPipeline1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_outreach_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_pipeline_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outreach_suppressions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_ingest_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "leads"`);

    for (const t of [
      'lead_outreach_events_type_enum',
      'lead_ingest_runs_status_enum',
      'outreach_suppressions_reason_enum',
      'leads_liveness_enum',
      'leads_enrichmentstatus_enum',
      'leads_status_enum',
      'leads_source_enum',
    ]) {
      await queryRunner.query(`DROP TYPE IF EXISTS "${t}"`);
    }
  }

  /**
   * Deliberately not a schema restore.
   *
   * Recreating five empty tables would be a lie: the code that reads them is
   * gone from this service, so an empty schema would satisfy the migration
   * runner while restoring nothing anyone can use. If these tables are ever
   * needed here again, load the archive named above — and then ask why the
   * pipeline is coming back into the product database.
   */
  public async down(): Promise<void> {
    throw new Error(
      'DropLeadsPipeline is not reversible in code. Restore from ' +
        'db-dump/leads-archive-2026-09-09.sql.gz if the leads schema is needed again.',
    );
  }
}
