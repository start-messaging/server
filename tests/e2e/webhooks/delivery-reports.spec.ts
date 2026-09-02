import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  seedCustomer,
  payload,
  unique,
  Customer,
} from '../helpers/actors.js';
import {
  WEBHOOK,
  messageRow,
  walletBalance,
  ledgerFor,
  fundWallet,
  seedSentMessage,
  pollStatus,
} from './helpers.js';

/**
 * The 2Factor delivery report callback (`/webhooks/2factor`, POST and GET) —
 * one of the two routes nobody has to authenticate to reach. The other,
 * `/health`, is pinned in tests/e2e/platform/health.spec.ts.
 *
 * The webhook is the only place in the product where an anonymous request
 * moves money. It carries no signature, no shared secret and no allowlist —
 * 2Factor simply POSTs a `SessionId` — so the entire boundary between one
 * customer's messages and another's is the unguessability of that id. That is
 * worth pinning precisely: the controller answers 200 to anything it is
 * handed, enqueues the body on a BullMQ queue, and the worker looks the
 * SessionId up across every tenant at once and debits whoever owns the match.
 *
 * These tests therefore assert against the database, not the response: the
 * response is `{received:true}` no matter what happened, by design. The only
 * non-200s here come from express's body parser, which refuses a malformed or
 * oversized body before the controller exists — both pinned below, because
 * only one of the two comes back with the right status.
 *
 * Not repeated here: the status/error-code decoding tables, which are covered
 * exhaustively by the unit spec at src/messages/queues/sms-webhook.processor.spec.ts,
 * and the "does not fall over on junk" smoke check in tests/e2e/platform/cross-cutting.spec.ts.
 */

test.describe('2factor delivery report edge cases', () => {
  let tenant: Customer;
  /** Owns the canary messages only, so counting a tenant's rows stays honest. */
  let canaryUserId: string;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    tenant = await createCustomer(request);
    canaryUserId = (await seedCustomer()).id;
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /**
   * Blocks until every webhook posted so far has been handled.
   *
   * The controller answers 200 the instant it enqueues, so "nothing happened"
   * can only be asserted after the queue has caught up — otherwise these tests
   * would pass just as happily against a worker that never ran. One worker at
   * BullMQ's default concurrency of 1, FIFO, so once a canary posted last has
   * landed, everything ahead of it is done. A timeout here means the queue is
   * not draining at all, which is itself the most important thing this file
   * can tell you.
   *
   * `resetDb()` does not disturb it — now for the opposite reason it used to.
   * The factory dropped the `/N` from REDIS_URL, so every queue lived on db 0
   * and simply escaped the flush; it honours the path now, the queues are on
   * this suite's own db, and what spares them is helpers/db.ts deliberately
   * excluding `${REDIS_KEY_PREFIX}:bull` and everything under it from its
   * sweep. Widen that exclusion and the worker loses its keys mid-run while
   * blocked on them; this helper is where it shows up first.
   */
  async function drainWebhookQueue(request: APIRequestContext): Promise<void> {
    const sessionId = unique('canary-session');
    // intendedCost 0: the canary must never need a wallet of its own.
    const id = await seedSentMessage(canaryUserId, {
      sessionId,
      intendedCost: 0,
    });
    const res = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'DELIVERED', Error: '000' },
    });
    expect(res.status(), await res.text()).toBe(200);
    await pollStatus(id, 'delivered');
  }

  test('a delivery report is accepted with no credential, and a forged one is neither rejected nor believed', async ({
    request,
  }) => {
    // 2Factor sends no credential at all, so @Public has to short-circuit the
    // guard before it ever inspects a header. If that decorator were dropped,
    // every delivery report would be answered 401, no message would ever leave
    // `sent`, and nothing would ever be billed — silently.
    //
    // The three answers being byte-identical is the point: a caller cannot
    // tell from the response whether a credential was read at all.
    const body = { SessionId: unique('nobody'), Status: 'DELIVERED' };

    const anonymous = await request.post(WEBHOOK, { data: body });
    const forgedJwt = await request.post(WEBHOOK, {
      data: body,
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    const forgedApiKey = await request.post(WEBHOOK, {
      data: body,
      headers: { 'X-API-Key': 'sk_live_definitely_not_a_real_key' },
    });

    for (const res of [anonymous, forgedJwt, forgedApiKey]) {
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload(res)).toEqual({ received: true });
    }
  });

  test('an unknown SessionId is answered exactly like a real one', async ({
    request,
  }) => {
    // The endpoint is anonymous, so any difference between "I know this id"
    // and "I do not" turns it into an oracle for enumerating live message ids.
    // intendedCost 0 so the "known" report settles without needing a wallet:
    // this test is about the two answers being indistinguishable, and a debit
    // that could fail for lack of funds would drag an unrelated variable in.
    const sessionId = unique('real-session');
    await seedSentMessage(tenant.id, { sessionId, intendedCost: 0 });

    const known = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'DELIVERED', Error: '000' },
    });
    const unknown = await request.post(WEBHOOK, {
      data: {
        SessionId: unique('never-existed'),
        Status: 'DELIVERED',
        Error: '000',
      },
    });

    expect(known.status()).toBe(unknown.status());
    expect(known.status(), await known.text()).toBe(200);
    // requestId and timestamp differ by design; the payload is the whole answer.
    expect(await payload(known)).toEqual(await payload(unknown));

    await drainWebhookQueue(request);

    // And a report for an id nobody owns must not invent a row to hang itself on.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "messages" WHERE "userId" = $1`,
      [tenant.id],
    );
    expect(Number(count)).toBe(1);
  });

  test('a poisoned report shape cannot wedge the queue for everyone else', async ({
    request,
  }) => {
    // One worker drains this queue for every customer. A payload that throws
    // where the worker cannot recover would stall delivery reporting — and
    // therefore billing — product-wide, so the shapes a hostile caller can
    // reach for are all checked to leave the queue still moving.
    const junk: unknown[] = [
      { SessionId: [unique('a'), unique('b')], Status: 'DELIVERED' }, // array where a scalar belongs
      { SessionId: { nested: true }, Status: 'DELIVERED' }, // object where a scalar belongs
      { SessionId: 42, Status: 7 }, // numbers, not strings
      { SessionId: null, Status: null },
      { SessionId: '', Status: '' },
      { SessionId: '💥🙈', Status: 'DELIVERED 💥' },
      { SessionId: `  ${unique('padded')}  `, Status: '  DELIVERED  ' },
      { SessionId: 'x'.repeat(10_000), Status: 'DELIVERED' },
      {
        Status: 'DELIVERED',
        extra: { deeply: { nested: { junk: [1, 2, 3] } } },
      },
      [],
      {},
    ];

    for (const data of junk) {
      const res = await request.post(WEBHOOK, { data });
      expect(res.status(), `payload ${JSON.stringify(data).slice(0, 80)}`).toBe(
        200,
      );
    }

    // The canary is the assertion: it is only delivered if the worker survived
    // all of the above and is still taking jobs.
    await drainWebhookQueue(request);
  });

  test('a delivery report charges the wallet exactly once, for the cost the send intended', async ({
    request,
  }) => {
    await fundWallet(tenant.id, 10);
    const sessionId = unique('paid-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    // Field-for-field the shape production logs show.
    const res = await request.post(WEBHOOK, {
      data: {
        mode: 'SMS_OTP',
        SessionId: sessionId,
        Status: 'DELIVERED',
        To: '918305891734',
        Retry: '0',
        Error: '000',
        SmsStatus: 'DELIVERED',
      },
    });
    expect(res.status(), await res.text()).toBe(200);

    await pollStatus(messageId, 'delivered');

    expect(await walletBalance(tenant.id)).toBe(9.75);

    const ledger = await ledgerFor(messageId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe('debit');
    expect(Number(ledger[0].amount)).toBe(0.25);
    expect(Number(ledger[0].balanceBefore)).toBe(10);
    expect(Number(ledger[0].balanceAfter)).toBe(9.75);
    expect(ledger[0].referenceType).toBe('otp_usage');

    const row = await messageRow(messageId);
    // The charge is copied onto the message so history and ledger agree.
    expect(Number(row.costAmount)).toBe(0.25);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.failureReason).toBeNull();
  });

  test('five identical delivery reports arriving at once are charged once', async ({
    request,
  }) => {
    // 2Factor retries, and nothing stops anyone else replaying a report they
    // have seen. A second debit is a customer being billed twice for one SMS.
    await fundWallet(tenant.id, 10);
    const sessionId = unique('replay-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const body = { SessionId: sessionId, Status: 'DELIVERED', Error: '000' };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request.post(WEBHOOK, { data: body })),
    );
    for (const res of responses) {
      expect(res.status(), await res.text()).toBe(200);
    }

    await pollStatus(messageId, 'delivered');
    // All five were queued before the canary, so once it lands they are done.
    await drainWebhookQueue(request);

    expect(await walletBalance(tenant.id)).toBe(9.75);
    expect(await ledgerFor(messageId)).toHaveLength(1);
  });

  test('a delivery report is settled even when the wallet cannot cover it', async ({
    request,
  }) => {
    // 0.10 in the wallet, 0.25 to pay. The debit and the status update share
    // one transaction, and this used to assert the refusal: the throw rolled
    // the status write back with it and the message stayed at `sent`.
    //
    // That was the worst of both. 2Factor posts this report once, the job was
    // retried three times inside ten seconds against the same empty wallet and
    // then deleted, and the reconcile sweep cannot re-drive it because the
    // report API answers `unknown` for OTP-endpoint session ids. So the send
    // we had already paid for was never billed and the customer's message
    // never resolved. The wallet is allowed into arrears instead: the SMS is
    // on the handset either way, and the ledger is where that fact belongs.
    await fundWallet(tenant.id, 0.1);
    const sessionId = unique('broke-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const res = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'DELIVERED', Error: '000' },
    });
    expect(res.status(), await res.text()).toBe(200);

    await drainWebhookQueue(request);

    // 0.10 - 0.25. The debt is the honest figure.
    expect(await walletBalance(tenant.id)).toBe(-0.15);
    expect(await ledgerFor(messageId)).toHaveLength(1);

    const row = await messageRow(messageId);
    expect(row.status).toBe('delivered');
    expect(row.deliveredAt).not.toBeNull();
    expect(Number(row.costAmount)).toBe(0.25);
  });

  test('the report cannot dictate what the wallet is charged', async ({
    request,
  }) => {
    // The whole body is attacker-controlled and is filed into the message's
    // metadata verbatim. The debit reads `metadata.intendedCost`, so if the
    // payload were merged over the existing metadata instead of parked beneath
    // it, an anonymous request could name its own price and drain a wallet.
    await fundWallet(tenant.id, 10);
    const sessionId = unique('greedy-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const res = await request.post(WEBHOOK, {
      data: {
        SessionId: sessionId,
        Status: 'DELIVERED',
        Error: '000',
        intendedCost: 999,
        costAmount: 999,
        amount: 999,
        userId: canaryUserId,
        metadata: { intendedCost: 999 },
      },
    });
    expect(res.status(), await res.text()).toBe(200);

    await pollStatus(messageId, 'delivered');

    expect(await walletBalance(tenant.id)).toBe(9.75);
    const ledger = await ledgerFor(messageId);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(0.25);

    const row = await messageRow(messageId);
    expect(Number(row.costAmount)).toBe(0.25);
    // Ours survives; theirs is quarantined under webhook_payload.
    expect(row.metadata?.intendedCost).toBe(0.25);
    expect(row.metadata?.webhook_payload?.intendedCost).toBe(999);
  });

  test('a failure report moves no money and records no cost', async ({
    request,
  }) => {
    await fundWallet(tenant.id, 10);
    const sessionId = unique('failed-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const res = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, SmsStatus: 'FAILED', Error: '013' },
    });
    expect(res.status(), await res.text()).toBe(200);

    await pollStatus(messageId, 'failed');

    expect(await walletBalance(tenant.id)).toBe(10);
    expect(await ledgerFor(messageId)).toHaveLength(0);

    const row = await messageRow(messageId);
    expect(Number(row.costAmount)).toBe(0);
    // The customer is told the curated barring explanation, never the
    // provider's own wording — that is kept separately, for admins.
    expect(row.failureReason).toContain('barring');
    expect(row.failureReason).not.toContain('2Factor');
    expect(row.failureReason).not.toBe(row.providerFailureReason);
  });

  test('a late failure report zeroes the recorded cost of a delivery already paid for', async ({
    request,
  }) => {
    // Current behaviour, pinned rather than endorsed. A message is delivered
    // and debited; a later FAILED report for the same SessionId — which any
    // anonymous caller can send — flips it to failed and resets costAmount to
    // 0, but nothing is refunded. The wallet and the message history then
    // disagree about the same 0.25, and only the wallet is right.
    await fundWallet(tenant.id, 10);
    const sessionId = unique('flipflop-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const delivered = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'DELIVERED', Error: '000' },
    });
    expect(delivered.status(), await delivered.text()).toBe(200);
    await pollStatus(messageId, 'delivered');
    expect(await walletBalance(tenant.id)).toBe(9.75);

    const failed = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, SmsStatus: 'FAILED', Error: '013' },
    });
    expect(failed.status(), await failed.text()).toBe(200);
    await pollStatus(messageId, 'failed');

    // The money stays gone: no refund path runs here.
    expect(await walletBalance(tenant.id)).toBe(9.75);
    expect(await ledgerFor(messageId)).toHaveLength(1);
    // ...while the message now claims it cost nothing.
    expect(Number((await messageRow(messageId)).costAmount)).toBe(0);
  });

  test('delivered, then failed, then delivered again bills the same SMS once', async ({
    request,
  }) => {
    // The sequence is not contrived. 2Factor sends several delivery reports
    // per message, out of order, and BullMQ retries the job three times; on
    // top of that the endpoint is anonymous, so anyone who has seen a report
    // can replay it. Nothing makes a terminal status terminal, so the message
    // really does travel delivered → failed → delivered.
    //
    // It used to be billed twice for that. The debit was guarded by "the
    // status right now is not DELIVERED", which the FAILED report in the
    // middle re-armed, and the zeroing of costAmount on FAILED completed the
    // loop by pushing the second charge onto metadata.intendedCost — which the
    // webhook payload is nested underneath and never clears. Three
    // unauthenticated requests, and the customer paid 0.50 for one SMS.
    //
    // Now the charge is keyed on the message in the ledger rather than on the
    // message's current status, so the second DELIVERED finds the debit
    // already booked and moves no money. What it does do is put the cost back
    // on the message row from that ledger entry, so the row stops claiming a
    // delivered send was free.
    await fundWallet(tenant.id, 10);
    const sessionId = unique('rebill-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const report = (data: Record<string, unknown>) =>
      request.post(WEBHOOK, { data: { SessionId: sessionId, ...data } });

    expect((await report({ Status: 'DELIVERED', Error: '000' })).status()).toBe(
      200,
    );
    await pollStatus(messageId, 'delivered');
    expect(await walletBalance(tenant.id)).toBe(9.75);

    expect((await report({ SmsStatus: 'FAILED', Error: '013' })).status()).toBe(
      200,
    );
    await pollStatus(messageId, 'failed');

    expect((await report({ Status: 'DELIVERED', Error: '000' })).status()).toBe(
      200,
    );
    await pollStatus(messageId, 'delivered');
    await drainWebhookQueue(request);

    const ledger = await ledgerFor(messageId);
    expect(ledger).toHaveLength(1);
    expect(ledger.map((l) => Number(l.amount))).toEqual([0.25]);
    // Exactly one quarter rupee gone, whatever order the three reports landed
    // in — not "about" one, the column is numeric(12,4).
    expect(await walletBalance(tenant.id)).toBe(9.75);
    // One SMS, one debit, and the message agrees with the ledger about it.
    expect(Number((await messageRow(messageId)).costAmount)).toBe(0.25);
  });

  test('a report for a deleted message moves no money', async ({ request }) => {
    await fundWallet(tenant.id, 10);
    const sessionId = unique('deleted-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });
    await sql(`UPDATE "messages" SET "deletedAt" = now() WHERE "id" = $1`, [
      messageId,
    ]);

    const res = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'DELIVERED', Error: '000' },
    });
    expect(res.status(), await res.text()).toBe(200);

    await drainWebhookQueue(request);

    // Billing a row the customer no longer has any way to see is a charge they
    // cannot reconcile. The lookup excludes soft-deleted rows; this is what
    // keeps that true from the outside.
    expect(await walletBalance(tenant.id)).toBe(10);
    expect(await ledgerFor(messageId)).toHaveLength(0);

    const row = await messageRow(messageId);
    expect(row.status).toBe('sent');
    expect(row.historyLength).toBe(0);
  });

  test('a delivery report only touches the message whose SessionId it names', async ({
    request,
  }) => {
    // The lookup is global — no tenant scope, no signature, no shared secret.
    // Nothing but the SessionId separates one customer's messages from
    // another's, so this is the whole of the isolation guarantee.
    await fundWallet(tenant.id, 10);
    const mineSession = unique('mine-session');
    const mine = await seedSentMessage(tenant.id, { sessionId: mineSession });

    const neighbour = await seedCustomer();
    await fundWallet(neighbour.id, 7);
    const theirs = await seedSentMessage(neighbour.id, {
      sessionId: unique('theirs-session'),
    });

    const res = await request.post(WEBHOOK, {
      data: { SessionId: mineSession, Status: 'DELIVERED', Error: '000' },
    });
    expect(res.status(), await res.text()).toBe(200);

    await pollStatus(mine, 'delivered');

    const untouched = await messageRow(theirs);
    expect(untouched.status).toBe('sent');
    expect(untouched.historyLength).toBe(0);
    expect(untouched.deliveredAt).toBeNull();
    expect(await walletBalance(neighbour.id)).toBe(7);
    expect(await ledgerFor(theirs)).toHaveLength(0);
  });

  test('a SessionId cannot smuggle SQL or a wildcard into the lookup', async ({
    request,
  }) => {
    await fundWallet(tenant.id, 10);
    const first = await seedSentMessage(tenant.id, {
      sessionId: unique('inject-a'),
    });
    const second = await seedSentMessage(tenant.id, {
      sessionId: unique('inject-b'),
    });

    // `%` and `_` are in here for a specific reason: they are inert against an
    // equality lookup and match everything against a LIKE one, so a lookup
    // rewritten to LIKE would settle and bill every message at once.
    const hostile = [
      "' OR '1'='1",
      "' OR 1=1 --",
      '%',
      '_',
      "x' UNION SELECT id FROM messages --",
      "'; UPDATE messages SET status='delivered'; --",
    ];

    for (const SessionId of hostile) {
      const res = await request.post(WEBHOOK, {
        data: { SessionId, Status: 'DELIVERED', Error: '000' },
      });
      expect(res.status(), `SessionId ${SessionId}`).toBe(200);
    }

    await drainWebhookQueue(request);

    for (const id of [first, second]) {
      const row = await messageRow(id);
      expect(row.status).toBe('sent');
      expect(row.historyLength).toBe(0);
    }
    expect(await walletBalance(tenant.id)).toBe(10);
  });

  test('an oversized report is refused — as a 500, which is the wrong answer', async ({
    request,
  }) => {
    // The body is copied verbatim into Redis and then into the message's
    // metadata column, so an accepted megabyte is a megabyte of attacker
    // storage. It is refused, which is the part that matters — but the status
    // it is refused with is a defect, pinned here rather than endorsed.
    //
    // body-parser's default 100kb limit (main.ts sets no body-parser options)
    // raises an http-errors PayloadTooLargeError carrying status 413. Nest's
    // express error layer maps SyntaxError and URIError to HttpException and
    // passes everything else through untouched (RoutesResolver.mapExternalException),
    // so AllExceptionsFilter sees a plain Error, not an HttpException, and
    // falls to its 500 default. Two consequences: 2Factor treats a non-2xx as
    // retryable and will re-post the same oversized body forever, and every
    // one of those is a 5xx in our own alerting for what is a client error.
    // Fixing the filter to honour `err.status` would turn this into a 413.
    const sessionId = unique('fat-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const res = await request.post(WEBHOOK, {
      data: {
        SessionId: sessionId,
        Status: 'DELIVERED',
        padding: 'x'.repeat(200_000),
      },
    });

    // Not 200 above all: whatever the number, the report must not be accepted.
    expect(res.status(), await res.text()).not.toBe(200);
    expect(res.status(), await res.text()).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    // The one mercy of the 500: the generic message, so the refusal leaks no
    // limits, no paths and no stack.
    expect(body.error.message).toBe('Internal server error');

    await drainWebhookQueue(request);
    const row = await messageRow(messageId);
    expect(row.status).toBe('sent');
    expect(row.historyLength).toBe(0);
  });

  test('a malformed body is refused as a client error, without enqueuing anything', async ({
    request,
  }) => {
    // Unlike the oversized case above, this one does come out right: a JSON
    // parse failure is a SyntaxError, and Nest's express error layer converts
    // exactly that into a BadRequestException, so it reaches
    // AllExceptionsFilter as an HttpException and comes back as the same
    // {code,message} envelope as every other client error — not as express's
    // default HTML error page, which under NODE_ENV=test would carry a stack
    // trace full of server paths.
    const sessionId = unique('broken-json-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const res = await request.post(WEBHOOK, {
      data: `{"SessionId": "${sessionId}", "Status": `,
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status(), await res.text()).toBe(400);
    expect(res.headers()['content-type']).toContain('application/json');
    const body = (await res.json()) as {
      success: boolean;
      statusCode: number;
      error: { code: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(400);
    expect(body.error.code).toBe('INVALID_INPUT');
    // The parser's own wording is fine to echo; a stack is not.
    expect(await res.text()).not.toContain('node_modules');
    expect(await res.text()).not.toMatch(/\n\s+at /);

    await drainWebhookQueue(request);
    const row = await messageRow(messageId);
    expect(row.status).toBe('sent');
    expect(row.historyLength).toBe(0);
  });

  test('a GET delivery report is honoured exactly like a POST', async ({
    request,
  }) => {
    // 2Factor's GET callback sends `Status`, never `SmsStatus`, and does not
    // shout it. Two separate fallbacks have to hold for that to bill: the
    // controller copies `Status` onto `SmsStatus`, and the worker reads
    // `SmsStatus || Status` anyway. Either alone is enough, which is why this
    // asserts the outcome rather than the mechanism.
    //
    // No `Error` field, deliberately. With `Error: '000'` the code table
    // short-circuits the whole decode and the status name is never read, so
    // the test would pass with case-insensitive status decoding removed —
    // and every GET-configured account that sends no error code would
    // silently stop billing.
    await fundWallet(tenant.id, 10);
    const sessionId = unique('get-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const res = await request.get(WEBHOOK, {
      params: { SessionId: sessionId, Status: 'Delivered' },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(await payload(res)).toEqual({ received: true });

    await pollStatus(messageId, 'delivered');
    expect(await walletBalance(tenant.id)).toBe(9.75);
    expect(await ledgerFor(messageId)).toHaveLength(1);
  });

  test('a report missing its SessionId or its status changes nothing', async ({
    request,
  }) => {
    await fundWallet(tenant.id, 10);
    const sessionId = unique('halfway-session');
    const messageId = await seedSentMessage(tenant.id, { sessionId });

    const noSession = await request.post(WEBHOOK, {
      data: { Status: 'DELIVERED', Error: '000' },
    });
    const noStatus = await request.post(WEBHOOK, {
      data: { SessionId: sessionId },
    });
    const emptyStatus = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: '', SmsStatus: '' },
    });

    for (const res of [noSession, noStatus, emptyStatus]) {
      // Still 200: a non-2xx tells 2Factor to retry, and a half-filled report
      // is not a transient failure worth retrying.
      expect(res.status(), await res.text()).toBe(200);
    }

    await drainWebhookQueue(request);

    const row = await messageRow(messageId);
    expect(row.status).toBe('sent');
    expect(row.historyLength).toBe(0);
    expect(await walletBalance(tenant.id)).toBe(10);
  });

  test('an unreadable status leaves the message in flight rather than failing it', async ({
    request,
  }) => {
    await fundWallet(tenant.id, 10);
    const sessionId = unique('mystery-session');
    // Seeded carrying a stale reason on purpose. The rule under test is
    // "failureReason is set only while status is FAILED", and the worker folds
    // any existing reason forward (`failureReason || message.failureReason`)
    // before handleStatusUpdate clears it on the non-FAILED branch. Seeded
    // with none, this test would assert null on a column nothing had ever
    // written, and would pass even if the clearing were deleted.
    const messageId = await seedSentMessage(tenant.id, {
      sessionId,
      failureReason: 'Stale reason from an earlier transient report',
    });

    const res = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'SOMETHING-NEW-FROM-THE-OPERATOR' },
    });
    expect(res.status(), await res.text()).toBe(200);

    // The status update is applied either way, so the history entry is the
    // proof the report really was processed before the assertions below.
    await expect
      .poll(async () => (await messageRow(messageId)).historyLength, {
        message: 'the webhook worker never recorded the unreadable status',
        timeout: 15_000,
        intervals: [100, 200, 300, 500, 1000],
      })
      .toBeGreaterThan(0);

    const row = await messageRow(messageId);
    // Calling a fate we cannot read a failure would both tell the customer
    // something untrue and permanently skip the delivery debit.
    expect(row.status).toBe('sent');
    expect(row.failureReason).toBeNull();
    expect(Number(row.costAmount)).toBe(0);
    expect(await walletBalance(tenant.id)).toBe(10);
    expect(await ledgerFor(messageId)).toHaveLength(0);
  });

  test('the webhook route answers verbs it does not implement with 404', async ({
    request,
  }) => {
    // Not 401 and not 500: the route exists for POST and GET only, and an
    // anonymous caller learns nothing else from probing it.
    const cases = [
      request.delete(WEBHOOK),
      request.put(WEBHOOK, { data: {} }),
      request.patch(WEBHOOK, { data: {} }),
    ];

    for (const pending of cases) {
      const res = await pending;
      expect(res.status(), await res.text()).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    }
  });

  test('a burst past the global rate limit is answered 200 for every report', async ({
    request,
  }) => {
    // @SkipThrottle (two-factor-webhook.controller.ts) is what keeps 2Factor's
    // delivery-report bursts off the global 1200/60s limiter. If the decorator
    // were dropped, everything past 1200 in a minute would 429, the provider
    // would retry-then-drop, and delivery status plus billing would silently
    // stall product-wide. The only honest pin is to send more than 1200
    // requests inside the window and watch none of them be refused.
    //
    // Unknown SessionIds keep every enqueued job a lookup miss, so the burst
    // is cheap for the worker; the drain at the end proves it also did not
    // wedge the queue for the reports that matter. Kept LAST in this file on
    // purpose: BullMQ lives in Redis DB 0, which resetDb's flush of /14 never
    // touches, so the backlog this parks would otherwise make the next test's
    // canary wait behind a thousand no-ops.
    test.setTimeout(240_000);

    const TOTAL = 1250;
    const CHUNK = 50;
    const started = Date.now();
    const statuses: number[] = [];
    for (let sent = 0; sent < TOTAL; sent += CHUNK) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(CHUNK, TOTAL - sent) }, (_, i) =>
          request.post(WEBHOOK, {
            data: {
              SessionId: `burst-${sent + i}-${process.pid}`,
              Status: 'DELIVERED',
            },
          }),
        ),
      );
      statuses.push(...batch.map((r) => r.status()));
    }
    const elapsed = Date.now() - started;

    // The pin is only meaningful if the burst fit the throttler's window.
    expect(
      elapsed,
      `the burst took ${elapsed}ms — too slow to have tested the 60s window`,
    ).toBeLessThan(60_000);

    const refused = statuses.filter((s) => s === 429).length;
    expect(
      refused,
      `${refused} delivery reports were throttled — @SkipThrottle is no longer in force`,
    ).toBe(0);
    expect(statuses.every((s) => s === 200)).toBe(true);

    // And the queue survives the burst: a real report posted after all 1250
    // no-ops still lands. Bounded generously — the worker chews through the
    // backlog first, FIFO at concurrency 1.
    const sessionId = unique('after-burst');
    const id = await seedSentMessage(canaryUserId, {
      sessionId,
      intendedCost: 0,
    });
    const res = await request.post(WEBHOOK, {
      data: { SessionId: sessionId, Status: 'DELIVERED', Error: '000' },
    });
    expect(res.status(), await res.text()).toBe(200);
    await expect
      .poll(async () => (await messageRow(id)).status, {
        message: 'the worker never surfaced from the burst backlog',
        timeout: 120_000,
        intervals: [250, 500, 1000],
      })
      .toBe('delivered');
  });
});
