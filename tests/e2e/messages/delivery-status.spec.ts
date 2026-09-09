import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  balanceOf,
  debitsFor,
  errorOf,
  expectNoProviderDetail,
  messageRow,
  seedProviderMessage,
  setBalance,
} from './helpers.js';

/**
 * The seams around the customer-triggered delivery status check
 * (`/messages/:id/check-status`).
 *
 * The controller is thin, and everything that can go wrong lives just
 * underneath it: a hand-written column projection that decides what the
 * customer is allowed to see, and the deferred wallet debit, which is the only
 * place in the messages and dashboard controllers where money moves.
 */
test.describe('messages and dashboard edge cases', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // Both controllers sit behind the global OnboardingGuard, so an
    // un-onboarded account cannot reach either of them. That gate has its own
    // test at the bottom of tests/e2e/messages/dashboard-stats.spec.ts;
    // everything else starts past it.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('checking delivery status', () => {
    test('a malformed id is refused before any lookup happens', async ({
      request,
    }) => {
      const res = await request.post('/messages/not-a-uuid/check-status', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(400);
      expect((await errorOf(res)).code).toBe('INVALID_INPUT');
    });

    test('another customer message is a 404, indistinguishable from an unknown one', async ({
      request,
    }) => {
      const other = await createCustomer(request);
      await onboardCustomer(other.id);
      const theirs = await seedProviderMessage(other.id, {
        status: 'sent',
        costAmount: 0.25,
        providerMsgId: 'console_not_yours',
      });
      const before = await messageRow(theirs);

      const unknown = await request.post(
        '/messages/00000000-0000-4000-8000-000000000000/check-status',
        { headers: auth(customer.accessToken) },
      );
      const foreign = await request.post(`/messages/${theirs}/check-status`, {
        headers: auth(customer.accessToken),
      });

      expect(unknown.status(), await unknown.text()).toBe(404);
      expect(foreign.status(), await foreign.text()).toBe(404);
      expect(await errorOf(unknown)).toEqual(await errorOf(foreign));

      // The refusal must also be inert: no status sync, no debit, on a message
      // the caller does not own.
      const after = await messageRow(theirs);
      expect(after.status).toBe(before.status);
      expect(new Date(after.updatedAt).getTime()).toBe(
        new Date(before.updatedAt).getTime(),
      );
      expect(await debitsFor(theirs)).toEqual([]);
    });

    test('an in-flight message is reported as sent, an expired one as failed', async ({
      request,
    }) => {
      // The projection collapses the internal lifecycle to the two states a
      // client can act on. The stored row keeps the real value — a check that
      // rewrote it would destroy the reconciliation sweeps' input.
      const cases: [string, string][] = [
        ['initiated', 'sent'],
        ['queued', 'sent'],
        ['expired', 'failed'],
      ];

      for (const [stored, reported] of cases) {
        const id = await seedDeliveredMessage(customer.id, {
          status: stored,
          costAmount: 0.25,
        });

        const res = await request.post(`/messages/${id}/check-status`, {
          headers: auth(customer.accessToken),
        });
        // 201, not 200: the route is a bare @Post with no @HttpCode, so Nest
        // applies its POST default. Asserting 200 here would be asserting a
        // decorator nobody wrote.
        expect(res.status(), await res.text()).toBe(201);
        expect((await payload<{ status: string }>(res)).status).toBe(reported);
        expect((await messageRow(id)).status).toBe(stored);
      }
    });

    test('a message with no provider record is never billed by a status check', async ({
      request,
    }) => {
      // No providerMsgId means nothing was ever handed to a provider, so there
      // is no delivery to bill for. Billing it would charge for a message that
      // does not exist upstream.
      await setBalance(customer.id, 10);
      const id = await seedDeliveredMessage(customer.id, {
        status: 'sent',
        costAmount: 0.25,
      });

      const res = await request.post(`/messages/${id}/check-status`, {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(201);

      expect(await balanceOf(customer.id)).toBe(10);
      expect(await debitsFor(id)).toEqual([]);
      expect((await messageRow(id)).status).toBe('sent');
    });

    test('the status check answers from the projection, never the provider record', async ({
      request,
    }) => {
      // This is the branch that once returned syncProviderStatus() straight to
      // the caller — the full entity, raw provider payload included.
      await setBalance(customer.id, 10);
      const id = await seedProviderMessage(customer.id, {
        status: 'sent',
        costAmount: 0.25,
        providerMsgId: 'console_sync_leak',
      });

      const res = await request.post(`/messages/${id}/check-status`, {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(201);

      const row = await payload<Record<string, unknown>>(res);
      expectNoProviderDetail(row);
      expect(row.status).toBe('delivered');
    });

    test('a delivered message is billed exactly once however often it is checked', async ({
      request,
    }) => {
      // The debit is deferred to the first DELIVERED transition, so the status
      // check is a customer-reachable write path. Polling it — which a client
      // waiting on a receipt does — must not charge per poll.
      await setBalance(customer.id, 10);
      const id = await seedProviderMessage(customer.id, {
        status: 'sent',
        costAmount: 0.25,
        providerMsgId: 'console_billing_once',
      });

      const first = await request.post(`/messages/${id}/check-status`, {
        headers: auth(customer.accessToken),
      });
      expect(first.status(), await first.text()).toBe(201);
      expect((await payload<{ status: string }>(first)).status).toBe(
        'delivered',
      );

      const second = await request.post(`/messages/${id}/check-status`, {
        headers: auth(customer.accessToken),
      });
      expect(second.status(), await second.text()).toBe(201);
      const third = await request.post(`/messages/${id}/check-status`, {
        headers: auth(customer.accessToken),
      });
      expect(third.status(), await third.text()).toBe(201);

      // Exact rupees, not "about". 10 - 0.25 and nothing else.
      expect(await debitsFor(id)).toEqual([0.25]);
      expect(await balanceOf(customer.id)).toBe(9.75);

      const row = await messageRow(id);
      expect(Number(row.costAmount)).toBe(0.25);
      expect(row.status).toBe('delivered');
    });

    test('two simultaneous status checks cannot bill the same message twice', async ({
      request,
    }) => {
      // A client that fires a retry while the first request is still in
      // flight is the realistic version of this, and it used to charge the
      // customer twice for one delivery. The only guard against a second debit
      // was `message.status !== DELIVERED`, read from an entity loaded
      // *before* the transaction opens: the wallet's pessimistic_write lock
      // serialised the two debits but had nothing to merge them on, so the
      // second waited, re-read a balance that was still sufficient, and booked
      // its own 0.25.
      //
      // The debit is now keyed on (referenceType, referenceId) in the ledger
      // and asked for under that same lock, so the second request finds the
      // charge already booked and moves no money.
      //
      // A pass is not by itself proof the guard holds — it may only mean
      // Playwright sent the second request after the first had committed — but
      // a failure is proof it does not. Do not relax this to "at most two
      // debits".
      await setBalance(customer.id, 10);
      const id = await seedProviderMessage(customer.id, {
        status: 'sent',
        costAmount: 0.25,
        providerMsgId: 'console_billing_race',
      });

      const results = await Promise.all([
        request.post(`/messages/${id}/check-status`, {
          headers: auth(customer.accessToken),
        }),
        request.post(`/messages/${id}/check-status`, {
          headers: auth(customer.accessToken),
        }),
      ]);
      for (const res of results) {
        expect(res.status(), await res.text()).toBeLessThan(500);
      }

      expect(
        await debitsFor(id),
        'one delivery was billed more than once',
      ).toEqual([0.25]);
      expect(await balanceOf(customer.id)).toBe(9.75);
    });

    test('a delivery that cannot be paid for is still settled, into arrears', async ({
      request,
    }) => {
      // The balance can be spent between the send and the delivery report, so
      // an unaffordable debit is reachable in production. This used to assert
      // the refusal — no debit, message left at `sent` — under the reasoning
      // that a negative balance would mean giving a message away. It was the
      // refusal that gave it away: the charge and the status write share a
      // transaction, so the throw rolled both back, and nothing ever re-drove
      // it. The message stayed unresolved and the send was never billed.
      //
      // The SMS is on the handset and we have already paid for it. So it is
      // booked, the wallet goes into arrears, and the debt is visible instead
      // of lost.
      await setBalance(customer.id, 0.1);
      const id = await seedProviderMessage(customer.id, {
        status: 'sent',
        costAmount: 0.25,
        providerMsgId: 'console_unpayable',
      });

      const res = await request.post(`/messages/${id}/check-status`, {
        headers: auth(customer.accessToken),
      });
      expect(res.ok(), await res.text()).toBeTruthy();

      expect(await balanceOf(customer.id)).toBe(-0.15);
      expect(await debitsFor(id)).toHaveLength(1);
      expect((await messageRow(id)).status).toBe('delivered');
    });
  });
});
