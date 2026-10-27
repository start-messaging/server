import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Runs the payment reconciliation sweep on demand.
 *
 * Every field is optional: an empty body is the same sweep the scheduler runs.
 * The bounds exist because this fires one gateway API call per order — a
 * mistyped window must bounce, not hammer the gateway.
 */
export class ReconcilePaymentsDto {
  @ApiPropertyOptional({
    description:
      'Report what would be credited and change nothing. Run this first when ' +
      'widening the window past the scheduler default.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: 'How far back to look for unpaid orders. Default 72.',
    minimum: 1,
    maximum: 2160,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2160)
  lookbackHours?: number;

  @ApiPropertyOptional({
    description: 'Ignore orders younger than this. Default 3.',
    minimum: 0,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  minAgeMinutes?: number;

  @ApiPropertyOptional({
    description: 'Most orders to ask the gateway about. Default 100.',
    minimum: 1,
    maximum: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
