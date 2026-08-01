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
 *
 * PRECISION: the boundary timestamp is read back out of Postgres as text at
 * full microsecond precision, not via a JS `Date`. `Date` only holds
 * milliseconds, and `timestamptz` holds microseconds, so encoding the cursor
 * from an entity would round the boundary *down* — and every row between the
 * rounded value and the true one then fails the `<` test and is skipped
 * silently. Rows written by TypeORM carry millisecond precision and hide this,
 * but anything inserted by raw SQL takes the column's `DEFAULT now()` and has
 * microseconds; the affiliate ledger is written exactly that way.
 */

/** Raw aliases for the two values the cursor is built from. */
const CURSOR_TS = 'cursor_ts';
const CURSOR_ID = 'cursor_id';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Emits an ISO-8601 string that keeps all six fractional digits. `::text`
 * would render Postgres' own format, which `Date.parse` is not required to
 * accept.
 */
const cursorTimestampExpr = (alias: string) =>
  `to_char("${alias}"."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface Cursor {
  /** ISO-8601 timestamp of the boundary row's createdAt, microsecond precision. */
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

  // The id is interpolated into a `::uuid` cast, so a tampered value that is a
  // string but not a UUID would otherwise sail through every check here and
  // fail inside Postgres — surfacing as a 500 for what is a bad request.
  if (!UUID_PATTERN.test(cursor.id)) {
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

  // Bound as text and cast in SQL, so the microseconds survive the round trip.
  // Passing `new Date(...)` here would truncate the boundary to milliseconds
  // and skip every row in between.
  qb.andWhere(
    `("${alias}"."createdAt", "${alias}"."id") < ((:cursorCreatedAt)::timestamptz, (:cursorId)::uuid)`,
    { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
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

  const { entities: rows, raw } = await qb
    .addSelect(cursorTimestampExpr(alias), CURSOR_TS)
    .addSelect(`"${alias}"."id"::text`, CURSOR_ID)
    .orderBy(`${alias}.createdAt`, 'DESC')
    .addOrderBy(`${alias}.id`, 'DESC')
    .take(limit + 1)
    .getRawAndEntities();

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  if (!hasNextPage || !last) {
    return { items, hasNextPage, nextCursor: null };
  }

  // Matched by id rather than by position: a caller whose query joins can get
  // more raw rows than entities, and indexing into `raw` would then read the
  // wrong row's timestamp.
  const boundary = (raw as Record<string, string>[]).find(
    (r) => r[CURSOR_ID] === last.id,
  );

  return {
    items,
    hasNextPage,
    nextCursor: encodeCursor({
      // The raw projection is the only full-precision source. Falling back to
      // the entity loses microseconds, so it is used only if the projection is
      // somehow absent — which would mean paging repeats a row rather than
      // skipping one, the safer of the two failures.
      createdAt:
        boundary?.[CURSOR_TS] ?? new Date(last.createdAt).toISOString(),
      id: last.id,
    }),
  };
}
