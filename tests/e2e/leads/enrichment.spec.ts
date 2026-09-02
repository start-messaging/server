import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import { createAdmin, payload, Customer } from '../helpers/actors.js';
import {
  ABSENT_UUID,
  contactPageHtml,
  enrich,
  errorOf,
  leadRow,
  parkedPageHtml,
  seedLead,
  sitePageHtml,
  startFixtureServer,
} from './helpers.js';

/**
 * The synchronous enrichment endpoint: POST /admin/leads/:id/enrich crawls
 * the fixture "site" for the lead's domain and records what it found.
 *
 * The fixture domains are unregistered on purpose: enrichment does one real
 * MX lookup per crawl, and NXDOMAIN is what pins `hasMx: false` — the only
 * branch of the crawler this suite lets touch the real network.
 */

const HAPPY = 'happy-blooms.e2e-fixture.in';
const FALLBACK = 'fallback-blooms.e2e-fixture.in';
const SILENT = 'silent-blooms.e2e-fixture.in';
const BROKEN = 'broken-blooms.e2e-fixture.in';
// The India-signal trio. Seeded with isIndian null (generic-TLD state) so
// the page content is the only thing that can move the flag.
const RUPEE_SITE = 'silver-petals.e2e-fixture.in';
const INR_SITE = 'quiet-petals.e2e-fixture.in';
const INR_CITY_SITE = 'twin-petals.e2e-fixture.in';
// A registrar parking template — the HTML-signature detection path (the NS
// path needs real DNS; parked-detector.spec.ts unit-tests that matcher).
const PARKED_SITE = 'parked-blooms.e2e-fixture.in';

/** What the happy-path page verifies structurally, plus its wa.me link. */
const HAPPY_SIGNALS = ['auth', 'payments', 'ecommerce', 'whatsapp', 'mobile_app'];

test.describe('lead enrichment', () => {
  let fixture: { close(): Promise<void> };
  let admin: Customer;

  test.beforeAll(async () => {
    fixture = await startFixtureServer({
      [`/site/${HAPPY}`]: {
        body: sitePageHtml({
          domain: HAPPY,
          title: 'Happy Blooms Studio',
          description: 'Handmade bouquets, same-day across Delhi.',
          email: 'hello@happy-mail.in',
          tel: '+91 98765 43210',
          wa: '+919876543211',
          // Qualification went structural: one verifiable FACT per signal
          // family (an SDK script, a password form, a cart/store link) —
          // the marker words this page used to carry no longer count. The
          // wa.me anchor above is the whatsapp signal's own evidence.
          scripts: ['https://checkout.razorpay.com/v1/checkout.js'],
          passwordForm: true,
          links: ['/cart', 'https://play.google.com/store/apps/details?id=x'],
        }),
      },
      // The fallback pair: no address on the landing page, one behind the
      // contact link. The href must be the ABSOLUTE /site/<domain>/contact
      // path — resolved against the fetched URL, a relative "contact" would
      // drop the domain segment and miss the fixture route.
      [`/site/${FALLBACK}`]: {
        body: sitePageHtml({
          domain: FALLBACK,
          contactHref: `/site/${FALLBACK}/contact`,
        }),
      },
      [`/site/${FALLBACK}/contact`]: {
        body: contactPageHtml({ email: 'owner@fallback-mail.in' }),
      },
      [`/site/${SILENT}`]: {
        body: sitePageHtml({ domain: SILENT }),
      },
      [`/site/${BROKEN}`]: {
        status: 500,
        body: 'fixture: deliberate server error',
      },
      // One STRONG India signal (₹ prices) and no contacts at all.
      [`/site/${RUPEE_SITE}`]: {
        body: sitePageHtml({
          domain: RUPEE_SITE,
          signals: ['Sale: ₹ 499 per bouquet'],
        }),
      },
      // Exactly one WEAK signal — the INR currency code.
      [`/site/${INR_SITE}`]: {
        body: sitePageHtml({
          domain: INR_SITE,
          signals: ['Prices quoted in INR'],
        }),
      },
      // Two distinct WEAK signals: INR + a city from LEADS_INDIA_TOKENS.
      [`/site/${INR_CITY_SITE}`]: {
        body: sitePageHtml({
          domain: INR_CITY_SITE,
          signals: ['Prices quoted in INR', 'Ships from Pune weekly'],
        }),
      },
      [`/site/${PARKED_SITE}`]: { body: parkedPageHtml() },
    });
  });

  test.afterAll(async () => {
    // Serial suite, shared port 41100 — close so the next spec can bind.
    await fixture.close();
    await closeDb();
  });

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test('a reachable site yields contacts, signals and an upgraded isIndian', async ({
    request,
  }) => {
    // isIndian starts null — a non-.in TLD's state — so the +91 numbers are
    // what must flip it, not the seed.
    const lead = await seedLead({ domain: HAPPY, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.contactEmails).toEqual(['hello@happy-mail.in']);
    expect(body.contactPhones).toEqual(['+919876543210']);
    expect(body.contactWhatsapp).toEqual(['+919876543211']);
    expect(body.siteTitle).toBe('Happy Blooms Studio');
    expect(body.siteDescription).toBe(
      'Handmade bouquets, same-day across Delhi.',
    );

    expect([...body.qualificationSignals].sort()).toEqual(
      [...HAPPY_SIGNALS].sort(),
    );
    // Count of distinct verified signals, not a weighted sum — the weights
    // implied precision the evidence didn't have.
    expect(body.qualificationScore).toBe(HAPPY_SIGNALS.length);

    expect(body.enrichmentStatus).toBe('enriched');
    expect(body.enrichmentAttempts).toBe(1);
    expect(body.enrichmentError).toBeNull();
    expect(body.enrichedAt).not.toBeNull();
    // The fixture domain is unregistered, so the MX lookup NXDOMAINs.
    expect(body.hasMx).toBe(false);
    expect(body.isIndian, 'the +91 numbers upgrade null → true').toBe(true);

    const stored = await leadRow(lead.id);
    expect(stored.enrichmentStatus).toBe('enriched');
    expect(stored.contactEmails).toEqual(['hello@happy-mail.in']);
    expect(stored.isIndian).toBe(true);
  });

  test('a homepage without an address falls back to its contact page', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: FALLBACK });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    // The homepage has no mailto and no plain-text address, so this email can
    // only have come from the second fetch.
    expect(body.contactEmails).toEqual(['owner@fallback-mail.in']);
    expect(body.enrichmentStatus).toBe('enriched');
  });

  test('a reachable site with no contact route is no_contact, not failed', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: SILENT });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.enrichmentStatus).toBe('no_contact');
    expect(body.contactEmails).toEqual([]);
    expect(body.contactPhones).toEqual([]);
    expect(body.contactWhatsapp).toEqual([]);
    expect(body.enrichedAt, 'the crawl succeeded; only contacts are absent')
      .not.toBeNull();
    expect(body.enrichmentError).toBeNull();
  });

  test('a failing site stays pending for one retry, then goes failed', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: BROKEN });

    // Attempt 1 of LEADS_ENRICH_MAX_ATTEMPTS (default 2): the failure is
    // recorded but the lead stays pending so the sweep can retry it.
    const first = await enrich(request, admin.accessToken, lead.id);
    expect(first.status(), await first.text()).toBe(201);
    const one = await payload<any>(first);
    expect(one.enrichmentStatus).toBe('pending');
    expect(one.enrichmentAttempts).toBe(1);
    expect(one.enrichmentError).toContain('HTTP 500');
    expect(one.enrichedAt).toBeNull();

    // Attempt 2 spends the retry budget.
    const second = await enrich(request, admin.accessToken, lead.id);
    expect(second.status(), await second.text()).toBe(201);
    const two = await payload<any>(second);
    expect(two.enrichmentStatus).toBe('failed');
    expect(two.enrichmentAttempts).toBe(2);
    expect(two.enrichmentError).toContain('HTTP 500');

    const stored = await leadRow(lead.id);
    expect(stored.enrichmentStatus).toBe('failed');
    expect(stored.enrichmentAttempts).toBe(2);
  });

  test('rupee prices alone upgrade a generic-TLD lead to Indian', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: RUPEE_SITE, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    // ₹ is a strong signal: one is enough, no phone or GSTIN needed.
    expect(body.isIndian).toBe(true);
    expect(body.indiaSignals).toContain('rupee');

    const stored = await leadRow(lead.id);
    expect(stored.isIndian).toBe(true);
    expect(stored.indiaSignals).toContain('rupee');
  });

  test('a single weak India signal records itself but moves nothing', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: INR_SITE, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    // 'INR' alone could be a currency-converter widget; the flag stays
    // unknown, but the observation is persisted for the team to see.
    expect(body.isIndian).toBeNull();
    expect(body.indiaSignals).toEqual(['inr']);

    const stored = await leadRow(lead.id);
    expect(stored.isIndian).toBeNull();
    expect(stored.indiaSignals).toEqual(['inr']);
  });

  test('two distinct weak signals together upgrade the lead', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: INR_CITY_SITE, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.isIndian).toBe(true);
    expect([...body.indiaSignals].sort()).toEqual(['city', 'inr']);

    const stored = await leadRow(lead.id);
    expect(stored.isIndian).toBe(true);
    expect([...stored.indiaSignals].sort()).toEqual(['city', 'inr']);
  });

  test('a parked page is recorded parked, with the registrar template discarded', async ({
    request,
  }) => {
    // The fixture is stuffed with the REGISTRAR's contacts and structural
    // "signals" (a payments SDK, a login form, a cart link) — the exact
    // template that used to score parked domains as hot leads.
    const lead = await seedLead({ domain: PARKED_SITE, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.enrichmentStatus).toBe('parked');
    // Nothing from the registrar is stored: not its contacts…
    expect(body.contactEmails).toEqual([]);
    expect(body.contactPhones).toEqual([]);
    expect(body.contactWhatsapp).toEqual([]);
    // …and not its "fit".
    expect(body.qualificationScore).toBe(0);
    expect(body.qualificationSignals).toEqual([]);
    // What WAS seen is kept for context, and the recheck clock starts.
    expect(body.siteTitle).toBe('Parked by Example Registrar');
    expect(body.enrichedAt).not.toBeNull();
    expect(body.enrichmentError).toBeNull();
    // A parking template says nothing about the business's country.
    expect(body.isIndian).toBeNull();

    const stored = await leadRow(lead.id);
    expect(stored.enrichmentStatus).toBe('parked');
    expect(stored.contactEmails).toEqual([]);
    expect(stored.qualificationScore).toBe(0);
  });

  test('an unknown lead id is a NOT_FOUND envelope', async ({ request }) => {
    const res = await enrich(request, admin.accessToken, ABSENT_UUID);
    expect(res.status()).toBe(404);
    expect((await errorOf(res)).code).toBe('NOT_FOUND');
  });
});
