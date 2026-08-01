import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/pagination.constants.js';

/** Query-string spellings accepted for a boolean flag. */
const TRUE_VALUES = ['true', '1', 'yes', 'y'] as const;
const FALSE_VALUES = ['false', '0', 'no', 'n'] as const;

export const BOOLEAN_QUERY_VALUES = [...TRUE_VALUES, ...FALSE_VALUES];

/**
 * Treats a present-but-empty query parameter as absent.
 *
 * `?page=` is what a truncated or hand-edited shared link looks like, and
 * `Number('')` is `0` — finite, so it survives coercion and then fails
 * `@Min(1)`. The result was a 400 on a link a user had simply copied badly,
 * rather than the default page. Returning undefined lets `@IsOptional` and the
 * property default do their job.
 */
/**
 * Does the whole string-to-number coercion in one place.
 *
 * It reads the raw value off the source object rather than the transformed
 * one, because `@Type(() => Number)` turns `''` into `0` — finite, so it
 * survives and then trips `@Min(1)`. Splitting the work between `@Type` and a
 * `@Transform` does not work either: whichever runs second wins, so returning
 * the raw string from a transform undoes the numeric conversion and every
 * valid `?limit=3` fails `@IsInt` instead.
 *
 * A non-numeric value becomes NaN and is left for `@IsInt` to reject, so
 * `?page=abc` is still a 400 rather than being silently defaulted.
 */
const OptionalPositiveInt = (fallback: number) =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj?.[key];
    const missing =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '');

    // The fallback is returned here rather than `undefined`, because
    // class-transformer assigns whatever this returns onto the instance — and
    // assigning `undefined` overwrites the class field default, leaving `page`
    // genuinely undefined. That reached TypeORM's `skip()` and became a 500.
    return missing ? fallback : Number(raw);
  });

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @OptionalPositiveInt(1)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @OptionalPositiveInt(DEFAULT_PAGE_SIZE)
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
