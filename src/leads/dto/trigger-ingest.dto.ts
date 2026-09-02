import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class TriggerIngestDto {
  @ApiPropertyOptional({
    description: 'NRD file date, YYYY-MM-DD. Defaults to yesterday (IST).',
    example: '2026-08-13',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({
    description:
      'Backfill: enqueue one run per day, walking backwards from `date` ' +
      '(or yesterday). Max 10 — the free feed keeps ~10 days of files.',
    example: 3,
    minimum: 1,
    maximum: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  days?: number;

  @ApiPropertyOptional({
    description:
      'Source override for one run (e.g. the 60-day aggregate mirror). ' +
      'Only https URLs on the pinned host allowlist are accepted — see ' +
      'NrdIngestService.assertAllowedSourceUrl.',
    example: 'https://dl.cenk.app/nrd/aggregate.zip',
  })
  @IsOptional()
  // Shape check only; the real gate is the service's host allowlist, which
  // must hold wherever the fetch happens, not just on this route.
  @Matches(/^https?:\/\/\S+$/)
  url?: string;

  @ApiPropertyOptional({
    description:
      'Re-run days already marked completed. For when the ingest FILTER ' +
      'changed after a day ran (e.g. ingest-all widening): a forced re-run ' +
      'touches no existing lead (ON CONFLICT DO NOTHING) and only inserts ' +
      'the newly-admitted domains. The scheduler never forces.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
