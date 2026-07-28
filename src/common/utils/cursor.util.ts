import { BadRequestException } from '@nestjs/common';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * Keyset ("cursor") pagination.
 *
 * Offset pagination has to walk and discard every row before the page it
 * wants, so page 5,000 costs 5,000 pages of work. Keyset pagination instead
 * remembers where the last page ended and seeks straight there, so every page
 * costs the same regardless of depth. It is also stable under concurrent
 * inserts: rows added while a client is paging cannot shift the window and
 * cause a row to be skipped or repeated.
 *
 * The trade-off is that you can only go forwards and backwards, not jump to an
 * arbitrary page number — which is why the dashboards keep offset pagination
 * and the machine-facing list APIs offer this alongside it.
 *
 * The sort key is (createdAt, id). createdAt alone is not unique — two rows
 * written in the same millisecond would make the boundary ambiguous — so the
 * primary key breaks ties and guarantees a total order.
 */

export interface Cursor {
  /** ISO-8601 timestamp of the boundary row's createdAt. */
  createdAt: string;
  /** Primary key of the boundary row, used to break timestamp ties. */
  id: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

/** Shapes a cursor page into the envelope the response interceptor expects. */
export function cursorResponse<T>(page: CursorPage<T>, limit: number) {
  return {
    data: page.items,
    pagination: {
      limit,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
    },
  };
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Malformed cursor');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Cursor).createdAt !== 'string' ||
    typeof (parsed as Cursor).id !== 'string'
  ) {
    throw new BadRequestException('Malformed cursor');
  }

  const cursor = parsed as Cursor;
  if (Number.isNaN(Date.parse(cursor.createdAt))) {
    throw new BadRequestException('Malformed cursor');
  }

  return cursor;
}

/**
 * Restricts a query to rows strictly after the cursor in (createdAt, id)
 * descending order, using a row-value comparison so a composite index on
 * (createdAt DESC, id DESC) can seek directly to the boundary.
 */
export function applyCursor<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  cursor: Cursor | undefined,
): SelectQueryBuilder<T> {
  if (!cursor) return qb;

  qb.andWhere(
    `("${alias}"."createdAt", "${alias}"."id") < (:cursorCreatedAt, :cursorId)`,
    { cursorCreatedAt: new Date(cursor.createdAt), cursorId: cursor.id },
  );

  return qb;
}

/**
 * Runs a keyset-paginated query.
 *
 * Fetches one row beyond the page size to determine whether another page
 * exists without needing a count.
 */
export async function paginateByCursor<
  T extends ObjectLiteral & { id: string; createdAt: Date },
>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  limit: number,
  rawCursor?: string,
): Promise<CursorPage<T>> {
  const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;

  applyCursor(qb, alias, cursor);

  const rows = await qb
    .orderBy(`${alias}.createdAt`, 'DESC')
    .addOrderBy(`${alias}.id`, 'DESC')
    .take(limit + 1)
    .getMany();

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasNextPage,
    nextCursor:
      hasNextPage && last
        ? encodeCursor({
            createdAt: new Date(last.createdAt).toISOString(),
            id: last.id,
          })
        : null,
  };
}
