import { BadRequestException } from '@nestjs/common';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { PaginationMeta } from '../interfaces/api-response.interface.js';
import {
  COUNT_CEILING,
  COUNT_SKIPPED,
  MAX_OFFSET,
} from '../constants/pagination.constants.js';

export type SortOrder = 'ASC' | 'DESC';

/**
 * Maps a client-facing sort key to the column expression it is allowed to sort
 * by. Anything not present in the map is rejected, so a sort key can never
 * reach the SQL string.
 */
export type SortWhitelist = Record<string, string | string[]>;

export interface ResolvedSort {
  /** Column expressions to order by, in precedence order. */
  columns: string[];
  order: SortOrder;
}

/** Normalises the many spellings of a sort direction to ASC/DESC. */
export function normalizeSortOrder(
  value: string | undefined,
  fallback: SortOrder = 'DESC',
): SortOrder {
  if (!value) return fallback;
  return value.trim().toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

/**
 * Resolves a requested sort key against a whitelist.
 *
 * Interpolating a caller-supplied string into `ORDER BY` is how sort
 * parameters turn into crashes (unknown column) or injection. Resolving
 * through a fixed map means only column expressions this codebase wrote can
 * ever appear in the query.
 */
export function resolveSort(
  requested: string | undefined,
  whitelist: SortWhitelist,
  fallbackKey: string,
  order: string | undefined,
): ResolvedSort {
  const key = requested && requested in whitelist ? requested : fallbackKey;
  const mapped = whitelist[key] ?? whitelist[fallbackKey];

  if (!mapped) {
    throw new Error(
      `Sort whitelist is missing its fallback key "${fallbackKey}"`,
    );
  }

  return {
    columns: Array.isArray(mapped) ? mapped : [mapped],
    order: normalizeSortOrder(order),
  };
}

/** Applies a resolved sort to a query builder, NULLs last on descending. */
export function applySort<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  sort: ResolvedSort,
): SelectQueryBuilder<T> {
  const nulls = sort.order === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
  sort.columns.forEach((column, index) => {
    if (index === 0) {
      qb.orderBy(column, sort.order, nulls);
    } else {
      qb.addOrderBy(column, sort.order, nulls);
    }
  });
  return qb;
}

/**
 * Rejects offsets deep enough to be a denial-of-service by accident.
 * See MAX_OFFSET for why a ceiling exists at all.
 */
export function assertOffsetWithinLimit(page: number, limit: number): void {
  const offset = (page - 1) * limit;
  if (offset > MAX_OFFSET) {
    throw new BadRequestException(
      `Cannot page beyond ${MAX_OFFSET} rows with offset pagination. ` +
        `Narrow the filters, or use cursor pagination to walk the full set.`,
    );
  }
}

/** Applies page/limit to a query builder after validating the offset depth. */
export function applyPagination<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  page: number,
  limit: number,
): SelectQueryBuilder<T> {
  assertOffsetWithinLimit(page, limit);
  return qb.skip((page - 1) * limit).take(limit);
}

/**
 * Counts matching rows but stops at `ceiling`.
 *
 * Returns the exact total when it is at or below the ceiling. Past that it
 * returns the ceiling itself, which callers should render as "10,000+".
 */
export async function boundedCount<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  ceiling: number = COUNT_CEILING,
): Promise<number> {
  const limited = qb
    .clone()
    .skip(undefined)
    .take(undefined)
    .offset(undefined)
    .limit(ceiling)
    .orderBy();

  const rows = await limited.select('1', 'one').getRawMany();
  return rows.length;
}

export interface PaginateOptions {
  page: number;
  limit: number;
  /** Defaults to true. Read this from `PaginationQueryDto.shouldCount`. */
  withCount?: boolean;
}

/**
 * Runs a paginated query, optionally skipping the count.
 *
 * When counting is disabled the count query is not issued at all and the total
 * comes back as COUNT_SKIPPED, which buildPaginationMeta turns into an
 * unknown-total pager driven by whether a full page came back.
 */
export async function paginateQueryBuilder<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  options: PaginateOptions,
): Promise<[T[], number]> {
  const { page, limit } = options;
  applyPagination(qb, page, limit);

  if (options.withCount === false) {
    const items = await qb.getMany();
    return [items, COUNT_SKIPPED];
  }

  return qb.getManyAndCount();
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
  itemCount?: number,
): PaginationMeta {
  // Count was skipped: we cannot know the total, so derive "is there more?"
  // from whether this page came back full.
  if (total === COUNT_SKIPPED) {
    const receivedFullPage = (itemCount ?? 0) >= limit;
    return {
      page,
      limit,
      totalItems: COUNT_SKIPPED,
      totalPages: COUNT_SKIPPED,
      hasNextPage: receivedFullPage,
      hasPreviousPage: page > 1,
    };
  }

  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    totalItems: total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function paginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
) {
  return {
    data: items,
    pagination: buildPaginationMeta(total, page, limit, items.length),
  };
}
