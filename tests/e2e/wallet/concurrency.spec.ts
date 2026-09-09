import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  Customer,
} from '../helpers/actors.js';
import {
  OTP_COST,
  balanceOf,
  checkStatus,
  fundWallet,
  ledgerOf,
  seedBillableMessage,
  seedBillableMessages,
  walkLedger,
  walletOf,
} from './helpers.js';

/**
 * The customer wallet surface — `GET /wallet` and `GET /wallet/transactions` —
 * and the service underneath them, put under load.
 *
 * The controller is two lines long; everything worth testing is below it:
 *
 *  - `performReferencedDebit` takes the wallet row `FOR UPDATE`, and that lock
 *    plus the partial unique index on (otp_usage, message id) is the only
 *    thing standing between a burst of delivery reports and a double charge —
 *    so the concurrency block below fires real simultaneous requests at it
 *    rather than trusting the code that says `setLock('pessimistic_write')`.
 *
 *    Note what the lock is NOT protecting: a negative balance is permitted
 *    here on purpose. A delivery report settles a message that has already
 *    been sent and already been paid for, so refusing the charge loses the
 *    money rather than saving it. The invariant is one debit per message, not
 *    a floor at zero.
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

  test.describe('money under concurrency', () => {
    test('deliveries billed all at once leave a ledger with no interleaving', async ({
      request,
    }) => {
      // Six delivery reports for one customer arriving together is an ordinary
      // Tuesday for a provider that batches DLRs. Without SELECT ... FOR
      // UPDATE every one of them reads the same opening balance and writes the
      // same balanceBefore, so five debits are collected and one is charged.
      await fundWallet(customer.id, 6 * OTP_COST);
      const opening = await walletOf(customer.id);
      const ids = await seedBillableMessages(customer.id, 6);

      const results = await Promise.all(
        ids.map((id) => checkStatus(request, customer.accessToken, id)),
      );
      for (const res of results) {
        expect(res.ok(), await res.text()).toBeTruthy();
      }

      // Exactly zero. Not "about zero": every figure here is a quarter rupee.
      expect(await balanceOf(customer.id)).toBe(0);

      const rows = await ledgerOf(customer.id);
      const debits = rows.filter((r) => r.referenceType === 'otp_usage');
      expect(
        debits.length,
        'one delivery went unbilled or was billed twice',
      ).toBe(6);
      expect(debits.map((r) => Number(r.amount))).toEqual(
        Array(6).fill(OTP_COST),
      );

      // The whole history, from the wallet's first rupee, has to form one
      // unbroken chain — that is what "no two debits interleaved" means.
      expect(walkLedger(rows, 0)).toBe(0);

      // Each committed debit is one row version. A lost update leaves the
      // count of versions short of the count of transactions.
      const closing = await walletOf(customer.id);
      expect(closing!.version).toBe(opening!.version + 6);
    });

    test('a burst of deliveries is billed in full, even past zero', async ({
      request,
    }) => {
      // The realistic overdraw: the balance was spent between the send and the
      // delivery reports. All five were sent, all five reached a handset, and
      // we have already paid 2Factor for all five.
      //
      // This test used to assert the opposite — that two were billed and three
      // were refused, "and the platform has not given them away for free". The
      // second half of that sentence was never true: a refused debit rolled the
      // status write back with it, the webhook job was retried three times and
      // then deleted, and 2Factor sends the report once. So the three unbilled
      // sends were exactly that, given away, with the messages stranded at
      // `sent` for ever. Refusing a charge for an SMS that has already been
      // delivered does not save the money; it only loses the record of it.
      await fundWallet(customer.id, 0.6);
      const ids = await seedBillableMessages(customer.id, 5);

      const results = await Promise.all(
        ids.map((id) => checkStatus(request, customer.accessToken, id)),
      );
      expect(results.filter((r) => r.ok()).length).toBe(5);

      // 0.6 - (5 x 0.25). The wallet is now in arrears by 0.65, which is the
      // honest figure: it is what the customer owes for messages they sent.
      expect(await balanceOf(customer.id)).toBe(-0.65);

      const rows = await ledgerOf(customer.id);
      const debits = rows.filter((r) => r.referenceType === 'otp_usage');
      expect(debits.length).toBe(5);

      // Still exactly one debit per message, and still an unbroken chain — the
      // overdraft is permitted, double-billing is not.
      expect(new Set(debits.map((r) => r.referenceId)).size).toBe(5);
      expect(walkLedger(rows, 0)).toBe(-0.65);

      // Every message settled. Nothing is left stranded mid-flight.
      const [statuses] = await sql<{ delivered: string; sent: string }>(
        `SELECT
           (COUNT(*) FILTER (WHERE "status" = 'delivered'))::int AS delivered,
           (COUNT(*) FILTER (WHERE "status" = 'sent'))::int      AS sent
         FROM "messages" WHERE "userId" = $1`,
        [customer.id],
      );
      expect(Number(statuses.delivered)).toBe(5);
      expect(Number(statuses.sent)).toBe(0);
    });

    test('a top-up credits straight through the arrears', async ({
      request,
    }) => {
      // The other half of allowing the overdraft: it has to be recoverable by
      // the ordinary path, with no special handling for a negative opening
      // balance. A credit is applied to the balance as it stands, so the debt
      // is cleared first and the remainder is spendable.
      //
      // What bounds the debt in the first place is the pre-send check in
      // OtpService — `balance < costPerOtp` refuses, and a negative balance is
      // less than any cost, so an account in arrears cannot send at all. That
      // refusal is pinned in otp/send-access, send-persistence and
      // send-rate-limit; this file's concern is only the money.
      await fundWallet(customer.id, 0.25);
      const ids = await seedBillableMessages(customer.id, 2);
      await Promise.all(
        ids.map((id) => checkStatus(request, customer.accessToken, id)),
      );
      expect(await balanceOf(customer.id)).toBe(-0.25);

      const admin = await createAdmin(request);
      const credited = await request.post('/admin/wallet/topup', {
        data: {
          email: customer.email,
          amount: 1,
          description: 'clearing an overdraft',
        },
        headers: auth(admin.accessToken),
      });
      expect(credited.status(), await credited.text()).toBe(201);

      // 1 - 0.25, not 1: the credit lands on the balance it finds.
      expect(await balanceOf(customer.id)).toBe(0.75);

      const rows = await ledgerOf(customer.id);
      const credit = rows.find(
        (r) => r.type === 'credit' && Number(r.amount) === 1,
      );
      expect(
        credit,
        'the top-up should be one credit of exactly 1',
      ).toBeTruthy();
      expect(Number(credit!.balanceBefore)).toBe(-0.25);
      expect(Number(credit!.balanceAfter)).toBe(0.75);
      expect(walkLedger(rows, 0)).toBe(0.75);
    });

    test('a credit and a debit that land together both survive', async ({
      request,
    }) => {
      // A top-up racing a delivery report is how a customer who tops up because
      // they are running low actually experiences this. Whichever wins the lock,
      // both must be in the balance afterwards.
      const admin = await createAdmin(request);
      await fundWallet(customer.id, 10);
      const message = await seedBillableMessage(customer.id);

      const [credited, debited] = await Promise.all([
        request.post('/admin/wallet/topup', {
          data: {
            email: customer.email,
            amount: 100,
            description: 'top-up racing a delivery',
          },
          headers: auth(admin.accessToken),
        }),
        checkStatus(request, customer.accessToken, message),
      ]);
      expect(credited.status(), await credited.text()).toBe(201);
      expect(debited.ok(), await debited.text()).toBeTruthy();

      expect(await balanceOf(customer.id)).toBe(109.75);

      const rows = await ledgerOf(customer.id);
      // Order-independent on purpose: createdAt defaults to the transaction's
      // start time, so the request that waited on the lock can carry the
      // earlier timestamp. The chain is the truth, not the clock.
      expect(walkLedger(rows, 0)).toBe(109.75);
    });

    test('a debit for exactly the balance lands on zero, and the next one goes past it', async ({
      request,
    }) => {
      // The exact-boundary case is still the one worth pinning: spending the
      // last quarter rupee must land on 0 and not 0.0001 or -0.0001, because
      // these are numeric(12,4) read back through Number().
      //
      // What changed is the step after it. There used to be a
      // `balanceBefore < amount` refusal here, so the second delivery was
      // rejected and its message left unresolved; a delivery report settles a
      // send that already happened, so it is booked and the wallet goes into
      // arrears instead. The invariant that still holds is one debit per
      // message and an unbroken ledger chain.
      await fundWallet(customer.id, OTP_COST);
      const [first, second] = await seedBillableMessages(customer.id, 2);

      const spent = await checkStatus(request, customer.accessToken, first);
      expect(spent.ok(), await spent.text()).toBeTruthy();
      expect(await balanceOf(customer.id)).toBe(0);

      const past = await checkStatus(request, customer.accessToken, second);
      expect(past.ok(), await past.text()).toBeTruthy();

      expect(await balanceOf(customer.id)).toBe(-OTP_COST);
      const rows = await ledgerOf(customer.id);
      const debits = rows.filter((r) => r.referenceType === 'otp_usage');
      expect(debits.length).toBe(2);
      expect(new Set(debits.map((r) => r.referenceId)).size).toBe(2);
      expect(walkLedger(rows, 0)).toBe(-OTP_COST);
    });
  });
});
