import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * PATCH body for the runtime enrichment knobs. Every field is optional and
 * NULLABLE: absent = leave alone, null = revert to the env default, a value
 * = override. @IsOptional() makes class-validator skip the checks for null
 * (verified — same contract as teamRating), so null passes through to the
 * service as the explicit "clear" it is, while out-of-range values still
 * fail. The same ranges are CHECK-enforced on the table.
 */
export class UpdatePipelineSettingsDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Auto-run gate for the daily NRD ingest; null = env default. Manual ' +
      'ingest/run always bypasses',
  })
  @IsOptional()
  @IsBoolean()
  ingestEnabled?: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Auto-run gate for the hourly liveness probe sweep; null = env ' +
      'default. Manual liveness-sweep/run always bypasses',
  })
  @IsOptional()
  @IsBoolean()
  livenessEnabled?: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Master switch for the automatic drain; null = env default',
  })
  @IsOptional()
  @IsBoolean()
  enrichEnabled?: boolean | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  enrichBatchPerSweep?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  enrichConcurrency?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    maximum: 8760,
    description:
      'Re-crawl window in hours: crawled leads older than this re-enter ' +
      'the drain (the "swap all domains last crawled over X hours" cycle)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  enrichRecrawlHours?: number | null;
}
