import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/pagination.constants.js';

/** Query-string spellings accepted for a boolean flag. */
const TRUE_VALUES = ['true', '1', 'yes', 'y'] as const;
const FALSE_VALUES = ['false', '0', 'no', 'n'] as const;

export const BOOLEAN_QUERY_VALUES = [...TRUE_VALUES, ...FALSE_VALUES];

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC' = 'DESC';

  /**
   * Skip the `COUNT(*)` companion query.
   *
   * Counting is the expensive half of offset pagination: the rows themselves
   * come from an index in O(limit), but an exact total has to touch every
   * matching row. Clients that only render next/prev (rather than "page N of
   * M") can pass `withCount=false` and get a total of -1 back, trading the
   * exact total for a much cheaper request.
   *
   * Deliberately typed as a string rather than a boolean. The global
   * ValidationPipe runs with `enableImplicitConversion: true`, which coerces a
   * query param to its reflected TS type — and `Boolean('false')` is `true`, so
   * a boolean-typed field here would read `withCount=false` as *enabled*. Read
   * the parsed value through `shouldCount`, never off this field.
   */
  @ApiPropertyOptional({
    enum: BOOLEAN_QUERY_VALUES,
    default: 'true',
    description:
      'Set false to skip the total-count query. totalItems/totalPages come back as -1.',
  })
  @IsOptional()
  @IsIn(BOOLEAN_QUERY_VALUES)
  withCount?: string;

  /** Whether to run the count query. Defaults to true when unspecified. */
  get shouldCount(): boolean {
    if (this.withCount === undefined) return true;
    return !(FALSE_VALUES as readonly string[]).includes(
      this.withCount.trim().toLowerCase(),
    );
  }

  /** Zero-based row offset for the current page. */
  get offset(): number {
    return (this.page - 1) * this.limit;
  }
}
