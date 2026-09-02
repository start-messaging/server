import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  errorOf,
  expectNoProviderDetail,
  seedProviderMessage,
} from './helpers.js';

/**
 * The seams around reading a single message out of the customer message
 * history (`/messages/:id`).
 *
 * The controller is thin, and what can go wrong lives just underneath it: a
 * hand-written column projection that decides what the customer is allowed to
 * see, and the owner scoping that decides whose message they may see at all.
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

  test.describe('reading one message', () => {
    test('an unknown id and another customer id are answered identically', async ({
      request,
    }) => {
      // A 404 that differs from "does not exist" would let anyone walk the id
      // space and learn which messages are real.
      const other = await createCustomer(request);
      await onboardCustomer(other.id);
      const theirs = await seedDeliveredMessage(other.id, { costAmount: 0.25 });

      const unknown = await request.get(
        '/messages/00000000-0000-4000-8000-000000000000',
        { headers: auth(customer.accessToken) },
      );
      const foreign = await request.get(`/messages/${theirs}`, {
        headers: auth(customer.accessToken),
      });

      expect(unknown.status(), await unknown.text()).toBe(404);
      expect(foreign.status(), await foreign.text()).toBe(404);
      expect(await errorOf(unknown)).toEqual(await errorOf(foreign));
      expect((await errorOf(foreign)).code).toBe('NOT_FOUND');
    });

    test('a message the caller owns comes back without provider detail', async ({
      request,
    }) => {
      const id = await seedProviderMessage(customer.id, {
        providerMsgId: 'console_detail_check',
      });

      const res = await request.get(`/messages/${id}`, {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const row = await payload<Record<string, unknown>>(res);
      expect(row.id).toBe(id);
      expectNoProviderDetail(row);
    });

    test('an admin token gets no extra reach on the customer routes', async ({
      request,
    }) => {
      // Admins have their own message surface. On this one they are simply
      // another account, and their own account has no messages — a scoping
      // regression here would hand the whole platform history to /messages.
      const admin = await createAdmin(request);
      const mine = await seedDeliveredMessage(customer.id, {
        costAmount: 0.25,
      });

      const list = await request.get('/messages', {
        headers: auth(admin.accessToken),
      });
      expect(list.status(), await list.text()).toBe(200);
      expect(await payload<unknown[]>(list)).toEqual([]);

      const detail = await request.get(`/messages/${mine}`, {
        headers: auth(admin.accessToken),
      });
      expect(detail.status(), await detail.text()).toBe(404);
    });

    test('the message routes are closed to callers without a valid token', async ({
      request,
    }) => {
      const id = await seedDeliveredMessage(customer.id, { costAmount: 0.25 });
      // Two extra characters on the signature: the payload still parses, so
      // this only passes if the signature is actually verified.
      const tampered = `${customer.accessToken}xy`;

      const attempts: Record<string, string>[] = [
        {},
        { Authorization: 'Bearer not.a.jwt' },
        { Authorization: `Bearer ${tampered}` },
      ];

      for (const headers of attempts) {
        const detail = await request.get(`/messages/${id}`, { headers });
        expect(
          [401, 403],
          'a message was readable without a valid token',
        ).toContain(detail.status());

        const check = await request.post(`/messages/${id}/check-status`, {
          headers,
        });
        expect(
          [401, 403],
          'a status check ran without a valid token',
        ).toContain(check.status());
      }
    });
  });
});
