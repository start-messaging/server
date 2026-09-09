import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  TxRow,
  errorOf,
  ledgerOf,
  listTx,
  paginationOf,
  removeWallet,
  seedLedger,
  walletOf,
} from './helpers.js';

/**
 * The customer wallet surface — `GET /wallet/transactions` — and the service
 * underneath it.
 *
 * The controller is two lines long; everything worth testing is below it:
 *
 *  - `getWallet` INSERTS when no row exists, so the balance route is a write
 *    dressed as a read, while `findWalletId` on the history route deliberately
 *    is not. The two halves of one controller disagree, and both behaviours
 *    are pinned here so a change to either is visible.
 *  - the history route is the one place a customer hands us a sort key, a page
 *    number and a LIKE pattern, all of which reach Postgres.
 *
 * wallet/otp-billing covers the shape of the feature and
 * messages/delivery-status covers the status-check route itself. Nothing here
 * repeats either: no happy-path read, no per-message billing.
 *
 * Money is asserted exactly. Every figure below is a whole number of paise and
 * comes back out of `numeric(12,4)`, so `toBeCloseTo` would only hide the
 * defect it is meant to catch.
 */

test.describe('wallet edge cases', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // The wallet controller carries @SkipOnboarding, so this is not needed to
    // reach it — but the debit path runs through /messages, which is gated.
    // The one test that is about the gate makes its own un-onboarded account.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('the history route', () => {
    test('a customer with no wallet gets an empty page and no wallet is written', async ({
      request,
    }) => {
      // The opposite of the balance route, deliberately: listing history must
      // not insert, because a GET that writes cannot be served by a read
      // replica or inside a read-only transaction. This is the assertion that
      // holds findWalletId to that.
      await removeWallet(customer.id);

      const res = await listTx(request, customer.accessToken);
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload<TxRow[]>(res)).toEqual([]);

      const meta = await paginationOf(res);
      expect(meta.totalItems).toBe(0);
      expect(meta.totalPages).toBe(0);
      expect(meta.hasNextPage).toBe(false);

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
        [customer.id],
      );
      expect(Number(count), 'listing history created a wallet').toBe(0);
    });

    test('another customer history cannot be reached by asking for it in the query', async ({
      request,
    }) => {
      // The route takes no id, so the only way to aim it at someone else is to
      // smuggle one through the query string. `whitelist: true` strips unknown
      // properties rather than refusing them, and `referenceType` is a filter
      // the service supports but the DTO deliberately does not expose — so a
      // widening of that DTO would show up as the welcome credit disappearing.
      const other = await createCustomer(request);
      const theirWallet = await walletOf(other.id);
      await seedLedger(other.id, {
        delta: 500,
        description: 'NEIGHBOUR ONLY payment',
      });

      const res = await listTx(
        request,
        customer.accessToken,
        `walletId=${theirWallet!.id}&userId=${other.id}` +
          `&referenceType=admin_topup&bogus=1&search=NEIGHBOUR`,
      );
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload<TxRow[]>(res)).toEqual([]);

      const unfiltered = await listTx(
        request,
        customer.accessToken,
        `walletId=${theirWallet!.id}&referenceType=admin_topup&bogus=1`,
      );
      expect(unfiltered.status(), await unfiltered.text()).toBe(200);

      const rows = await payload<TxRow[]>(unfiltered);
      const mine = await walletOf(customer.id);
      expect(rows.length).toBe(1);
      expect(rows[0].walletId).toBe(mine!.id);
      // The welcome credit's referenceType is 'registration'. It came back
      // despite the query asking for 'admin_topup', which is what proves the
      // unknown parameter was dropped rather than applied.
      expect(rows[0].referenceType).toBe('registration');
    });

    test('page and limit refuse nonsense and treat an empty parameter as absent', async ({
      request,
    }) => {
      for (const query of [
        'page=0',
        'page=-1',
        'page=1.5',
        'page=abc',
        'page=1&page=2',
        'limit=0',
        'limit=-5',
        'limit=101',
        'limit=abc',
        'limit=1&limit=2',
      ]) {
        const res = await listTx(request, customer.accessToken, query);
        expect(res.status(), `${query} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      // The documented ceiling is usable, exactly.
      const atCap = await listTx(request, customer.accessToken, 'limit=100');
      expect(atCap.status(), await atCap.text()).toBe(200);
      expect((await paginationOf(atCap)).limit).toBe(100);

      // A truncated or hand-edited link — `?page=&limit=` — is the default
      // page, not a 400. Number('') is 0, which is finite and would otherwise
      // sail through coercion and die on @Min(1).
      const blank = await listTx(request, customer.accessToken, 'page=&limit=');
      expect(blank.status(), await blank.text()).toBe(200);
      const meta = await paginationOf(blank);
      expect(meta.page).toBe(1);
      expect(meta.limit).toBe(20);
    });

    test('paging deeper than the offset ceiling is refused at the boundary', async ({
      request,
    }) => {
      // MAX_OFFSET is 50,000 and the check is `offset > MAX_OFFSET`, so the
      // page that lands exactly on it must still work. Off by one here either
      // rejects a legitimate page or lets a scraper walk arbitrarily deep.
      const atCeiling = await listTx(
        request,
        customer.accessToken,
        'page=501&limit=100',
      );
      expect(atCeiling.status(), await atCeiling.text()).toBe(200);
      expect(await payload<TxRow[]>(atCeiling)).toEqual([]);

      const past = await listTx(
        request,
        customer.accessToken,
        'page=502&limit=100',
      );
      expect(past.status(), await past.text()).toBe(400);
      const error = await errorOf(past);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toContain('cursor');
    });

    test('an unknown sort key never reaches ORDER BY', async ({ request }) => {
      await seedLedger(
        customer.id,
        { delta: 1, description: 'sort a' },
        { delta: 5, description: 'sort b' },
        { delta: 3, description: 'sort c' },
      );

      // `constructor` and `__proto__` are in the list because the resolver used
      // to test membership with `in`, which walks the prototype chain and
      // resolves them to inherited functions that then reach the SQL string.
      for (const sortBy of [
        'walletId',
        'description',
        'amount; DROP TABLE "users"',
        'transaction.amount',
        'constructor',
        '__proto__',
        'toString',
        '',
      ]) {
        const res = await listTx(
          request,
          customer.accessToken,
          `sortBy=${encodeURIComponent(sortBy)}`,
        );
        expect(res.status(), `sortBy=${sortBy} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      // Nothing was executed on the way to those refusals.
      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "users"`,
      );
      expect(Number(count)).toBeGreaterThan(0);

      // And the keys that are allowed actually sort, rather than being accepted
      // and ignored.
      const res = await listTx(
        request,
        customer.accessToken,
        'sortBy=amount&sortOrder=ASC',
      );
      expect(res.status(), await res.text()).toBe(200);
      expect(
        (await payload<TxRow[]>(res)).map((r) => Number(r.amount)),
      ).toEqual([1, 3, 5, 10]);
    });

    test('an unrecognised sort direction falls back to newest first', async ({
      request,
    }) => {
      // sortOrder is a plain @IsString on the base DTO, so anything that is a
      // string arrives at normalizeSortOrder. Only 'ASC' means ascending;
      // everything else must mean DESC rather than reaching ORDER BY as-is.
      const older = new Date('2026-06-15T10:00:00.000Z');
      const newer = new Date('2026-06-15T12:00:00.000Z');
      await seedLedger(
        customer.id,
        { delta: 1, description: 'older entry', createdAt: older },
        { delta: 2, description: 'newer entry', createdAt: newer },
      );

      for (const sortOrder of ['sideways', 'DESC', 'desc', 'DROP TABLE']) {
        const res = await listTx(
          request,
          customer.accessToken,
          `sortOrder=${encodeURIComponent(sortOrder)}`,
        );
        expect(
          res.status(),
          `sortOrder=${sortOrder}: ${await res.text()}`,
        ).toBe(200);
        const rows = await payload<TxRow[]>(res);
        expect(rows[rows.length - 1].description, sortOrder).toBe(
          'older entry',
        );
      }

      // Lower case still means ascending — the value is upper-cased first.
      const ascending = await listTx(
        request,
        customer.accessToken,
        'sortOrder=asc',
      );
      expect(ascending.status(), await ascending.text()).toBe(200);
      expect((await payload<TxRow[]>(ascending))[0].description).toBe(
        'older entry',
      );

      // An array is not a string, and must not be coerced into one.
      const repeated = await listTx(
        request,
        customer.accessToken,
        'sortOrder=ASC&sortOrder=DESC',
      );
      expect(repeated.status(), await repeated.text()).toBe(400);
    });

    test('pages neither repeat nor lose a row when every entry shares a timestamp', async ({
      request,
    }) => {
      // A bulk credit writes several rows inside one transaction, and createdAt
      // defaults to the transaction's own clock — so identical timestamps are
      // the normal case, not a contrived one. Ordering on createdAt alone is
      // then non-deterministic between the two queries a pager makes, and rows
      // shuffle between pages: some seen twice, some never. The id tiebreaker
      // is what forbids that.
      const sameInstant = new Date('2026-06-15T10:00:00.000Z');
      await seedLedger(
        customer.id,
        Array.from({ length: 7 }, (_, i) => ({
          delta: 1,
          description: `burst entry ${i}`,
          createdAt: sameInstant,
        })),
      );

      const seen: string[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const res = await listTx(
          request,
          customer.accessToken,
          `page=${page}&limit=3`,
        );
        expect(res.status(), await res.text()).toBe(200);
        seen.push(...(await payload<TxRow[]>(res)).map((r) => r.id));
      }

      const stored = (await ledgerOf(customer.id)).map((r) => r.id);
      expect(stored.length).toBe(8); // seven seeded plus the welcome credit
      expect(new Set(seen).size, 'a row was served on two pages').toBe(
        seen.length,
      );
      expect([...seen].sort()).toEqual([...stored].sort());
    });

    test('the type filter takes the enum and nothing else', async ({
      request,
    }) => {
      await seedLedger(customer.id, { delta: -2, description: 'a spend' });

      const credits = await listTx(
        request,
        customer.accessToken,
        'type=credit',
      );
      expect(credits.status(), await credits.text()).toBe(200);
      const creditRows = await payload<TxRow[]>(credits);
      expect(creditRows.length).toBe(1);
      expect(creditRows[0].type).toBe('credit');

      const debits = await listTx(request, customer.accessToken, 'type=debit');
      expect((await payload<TxRow[]>(debits)).map((r) => r.type)).toEqual([
        'debit',
      ]);

      // A member of the enum with no rows behind it is an empty page — not the
      // same thing as an unrecognised value, which must be refused outright.
      const refunds = await listTx(
        request,
        customer.accessToken,
        'type=refund',
      );
      expect(refunds.status(), await refunds.text()).toBe(200);
      expect(await payload<TxRow[]>(refunds)).toEqual([]);

      for (const type of ['CREDIT', 'Credit', 'transfer', 'credit,debit', '']) {
        const res = await listTx(
          request,
          customer.accessToken,
          `type=${encodeURIComponent(type)}`,
        );
        expect(res.status(), `type=${type} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      // Repeating the parameter hands the DTO an array where it declared a
      // scalar. Express parses it into one, and an enum check that happened to
      // pass on an array would put a list straight into the WHERE clause.
      const repeated = await listTx(
        request,
        customer.accessToken,
        'type=credit&type=debit',
      );
      expect(repeated.status(), await repeated.text()).toBe(400);
    });

    test('a date window includes both of its endpoints', async ({
      request,
    }) => {
      // Statements are quoted on inclusive dates. An exclusive bound loses the
      // entry that landed exactly on the boundary, which is the one a customer
      // is usually chasing.
      const first = new Date('2026-06-15T10:00:00.000Z');
      const middle = new Date('2026-06-15T11:00:00.000Z');
      const last = new Date('2026-06-15T12:00:00.000Z');
      await seedLedger(
        customer.id,
        { delta: 1, description: 'window first', createdAt: first },
        { delta: 2, description: 'window middle', createdAt: middle },
        { delta: 3, description: 'window last', createdAt: last },
      );

      const inclusive = await listTx(
        request,
        customer.accessToken,
        `startDate=${first.toISOString()}&endDate=${last.toISOString()}&sortOrder=ASC`,
      );
      expect(inclusive.status(), await inclusive.text()).toBe(200);
      expect(
        (await payload<TxRow[]>(inclusive)).map((r) => r.description),
      ).toEqual(['window first', 'window middle', 'window last']);

      // A zero-width window still contains the entry sitting on it.
      const single = await listTx(
        request,
        customer.accessToken,
        `startDate=${middle.toISOString()}&endDate=${middle.toISOString()}`,
      );
      expect(
        (await payload<TxRow[]>(single)).map((r) => r.description),
      ).toEqual(['window middle']);

      // Backwards is empty, not an error: a date picker can produce it and a
      // 500 would be the wrong answer to "no transactions in that range".
      const backwards = await listTx(
        request,
        customer.accessToken,
        `startDate=${last.toISOString()}&endDate=${first.toISOString()}`,
      );
      expect(backwards.status(), await backwards.text()).toBe(200);
      expect(await payload<TxRow[]>(backwards)).toEqual([]);

      for (const query of [
        'startDate=15-06-2026',
        'startDate=not-a-date',
        'startDate=2026-13-45',
        'endDate=yesterday',
        'startDate=',
      ]) {
        const res = await listTx(request, customer.accessToken, query);
        expect(res.status(), `${query} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }
    });

    test('search is trimmed and case-insensitive, and whitespace alone is not a filter', async ({
      request,
    }) => {
      await seedLedger(customer.id, {
        delta: 4,
        description: 'Refund for a failed delivery',
      });

      for (const term of ['welcome', 'WELCOME', '  Welcome  ']) {
        const res = await listTx(
          request,
          customer.accessToken,
          `search=${encodeURIComponent(term)}`,
        );
        expect(res.status(), `search=${term}: ${await res.text()}`).toBe(200);
        const rows = await payload<TxRow[]>(res);
        expect(rows.length, `search=${term}`).toBe(1);
        expect(rows[0].description).toBe('Welcome credit');
      }

      // A search box the user cleared to spaces means "no filter", not "match
      // rows containing a space" — the service trims before deciding.
      const blank = await listTx(
        request,
        customer.accessToken,
        'search=%20%20',
      );
      expect(blank.status(), await blank.text()).toBe(200);
      expect((await payload<TxRow[]>(blank)).length).toBe(2);

      const overlong = await listTx(
        request,
        customer.accessToken,
        `search=${'x'.repeat(201)}`,
      );
      expect(overlong.status(), await overlong.text()).toBe(400);
      expect((await errorOf(overlong)).code).toBe('VALIDATION_ERROR');
    });

    test('a search term is a LIKE pattern, punctuation and all', async ({
      request,
    }) => {
      await seedLedger(
        customer.id,
        { delta: 1, description: 'Refund for 100% failure' },
        { delta: 2, description: 'Refund for 1000 rupees' },
        { delta: 3, description: 'Adjustment_7 for June' },
        { delta: 4, description: 'Adjustment 7 for June' },
      );

      // Pinned as it behaves. The term is interpolated into an ILIKE pattern
      // without escaping, so a customer searching for the literal text "100%"
      // also gets "1000 rupees", and "_" matches any single character. Wrong,
      // but wrong quietly — worth a failing test the day someone escapes it.
      const percent = await listTx(
        request,
        customer.accessToken,
        `search=${encodeURIComponent('100%')}`,
      );
      expect(percent.status(), await percent.text()).toBe(200);
      expect(
        (await payload<TxRow[]>(percent)).map((r) => r.description).sort(),
      ).toEqual(['Refund for 100% failure', 'Refund for 1000 rupees']);

      const underscore = await listTx(
        request,
        customer.accessToken,
        `search=${encodeURIComponent('Adjustment_7')}`,
      );
      expect((await payload<TxRow[]>(underscore)).length).toBe(2);

      // Quotes and semicolons are data, because the term is a bound parameter.
      const injection = await listTx(
        request,
        customer.accessToken,
        `search=${encodeURIComponent(`'; DROP TABLE "wallet_transactions"; --`)}`,
      );
      expect(injection.status(), await injection.text()).toBe(200);
      expect(await payload<TxRow[]>(injection)).toEqual([]);

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "wallet_transactions"`,
      );
      expect(Number(count)).toBe(5);
    });

    test('withCount=false trades the total for a cheaper page', async ({
      request,
    }) => {
      // The flag is a string on purpose: the pipe runs with implicit
      // conversion, and Boolean('false') is true, so a boolean-typed field
      // would read withCount=false as *enabled* and issue the count anyway.
      await seedLedger(
        customer.id,
        Array.from({ length: 5 }, (_, i) => ({
          delta: 1,
          description: `counted entry ${i}`,
        })),
      );

      const counted = await listTx(request, customer.accessToken, 'limit=2');
      expect(counted.status(), await counted.text()).toBe(200);
      expect((await paginationOf(counted)).totalItems).toBe(6);

      for (const spelling of ['false', '0', 'no', 'n']) {
        const res = await listTx(
          request,
          customer.accessToken,
          `limit=2&withCount=${spelling}`,
        );
        expect(res.status(), `withCount=${spelling}: ${await res.text()}`).toBe(
          200,
        );
        // The rows are unaffected — only the total is given up.
        expect((await payload<TxRow[]>(res)).length).toBe(2);

        const meta = await paginationOf(res);
        expect(meta.totalItems, spelling).toBe(-1);
        expect(meta.totalPages, spelling).toBe(-1);
        expect(meta.hasNextPage, spelling).toBe(true);
      }

      // Six rows at two a page: the last page is full, so an uncounted pager
      // still advertises a next page that does not exist. That is the declared
      // trade-off, pinned so it is a decision rather than a surprise.
      const lastPage = await listTx(
        request,
        customer.accessToken,
        'page=3&limit=2&withCount=false',
      );
      expect((await payload<TxRow[]>(lastPage)).length).toBe(2);
      expect((await paginationOf(lastPage)).hasNextPage).toBe(true);

      // 'TRUE' is in this list, not the one above: `shouldCount` lower-cases
      // before comparing, but @IsIn does not, so the DTO refuses the spelling
      // its own getter was written to handle. Refusing is the safe direction —
      // it is recorded here so the inconsistency is not mistaken for intent.
      for (const spelling of ['maybe', 'TRUE', '2', 'false,true']) {
        const res = await listTx(
          request,
          customer.accessToken,
          `withCount=${encodeURIComponent(spelling)}`,
        );
        expect(res.status(), `withCount=${spelling} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
