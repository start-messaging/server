import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

export class DailyUsageQueryDto extends PaginationQueryDto {
  /**
   * The shape check and the range check are both needed, and neither one
   * subsumes the other.
   *
   * `@Matches` only ever proved the string looked like a date. `?date=2026-13-45`
   * passed it, `new Date('2026-13-45T00:00:00.000Z')` in parseISTDate handed
   * back an Invalid Date, pg serialised that to the literal
   * "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN", Postgres rejected the timestamp
   * and the QueryFailedError — not an HttpException — surfaced as a 500.
   * `@IsDateString()` is class-validator's isISO8601, which holds the month to
   * 01-12 and the day to 01-31, so nothing that reaches parseISTDate can come
   * back Invalid any more and the 500 is closed at the pipe.
   *
   * Deliberately NOT `{ strict: true }`. Strict mode additionally rejects a day
   * the month does not have, which would turn `?date=2026-02-30` into a 400 —
   * and that rollover to March 2nd is asserted as current behaviour by
   * "an impossible day silently rolls over into the next month" in
   * tests/e2e/admin/ops-daily-usage.spec.ts. Narrowing the report to the day that
   * was actually asked for is a separate, deliberate decision with a payload
   * note owed to it; it is not this fix.
   *
   * `@Matches` stays because ISO 8601 is far wider than this endpoint:
   * '2026-03-11T00:00:00Z' and '2026-W11-3' are valid ISO and are not what an
   * IST calendar day means here.
   */
  @ApiPropertyOptional({
    description:
      'IST calendar date to report on (YYYY-MM-DD). Defaults to today.',
    example: '2026-07-26',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  @IsDateString({}, { message: 'date must be a real calendar date' })
  date?: string;

  @ApiPropertyOptional({
    description: 'Filter the report to matching customers',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
