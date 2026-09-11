import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { IsNotBefore } from '../../common/validators/is-not-before.validator.js';

/** Bucket widths the signup graph may be drawn at. */
export const GROWTH_GRANULARITIES = ['day', 'week'] as const;

export type GrowthGranularity = (typeof GROWTH_GRANULARITIES)[number];

/**
 * The window the growth screen reports on.
 *
 * `from`/`to` accept either a bare IST calendar day (`2026-03-11`) or a full
 * ISO 8601 instant. The two are not the same request and the service does not
 * pretend they are: a bare day is expanded to that whole IST day, so
 * `?from=2026-03-11&to=2026-07-26` covers the 26th rather than stopping at its
 * midnight — which is what an operator typing two dates means, and what the
 * first version of this got wrong by dropping the last day of every range.
 */
export class GrowthQueryDto {
  @ApiPropertyOptional({
    description:
      'Start of the window. An IST calendar day (YYYY-MM-DD) or an ISO 8601 instant. Defaults to 30 IST days back.',
    example: '2026-03-11',
  })
  @IsOptional()
  @IsDateString({}, { message: 'from must be a real ISO 8601 date' })
  from?: string;

  @ApiPropertyOptional({
    description:
      'End of the window, inclusive of the whole day when given as YYYY-MM-DD. Defaults to now.',
    example: '2026-07-26',
  })
  @IsOptional()
  @IsDateString({}, { message: 'to must be a real ISO 8601 date' })
  @IsNotBefore('from')
  to?: string;

  @ApiPropertyOptional({
    enum: GROWTH_GRANULARITIES,
    default: 'day',
    description: 'Bucket width for the signup series.',
  })
  @IsOptional()
  @IsIn([...GROWTH_GRANULARITIES])
  granularity?: GrowthGranularity;
}
