import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import { createAdmin, payload, Customer } from '../helpers/actors.js';
import {
  JS_SHELL_EMAIL,
  JS_SHELL_PHONE,
  enqueueEnrichLead,
  enrich,
  jsShellPage,
  leadRow,
  seedLead,
  startFixtureServer,
} from './helpers.js';

/**
 * The headless-browser enrichment tier, plus the tier-1 extraction upgrades
 * that motivated it (JSON-LD contact cards, obfuscated emails).
 *
 * The JS-shell fixture is the honest version of the problem: its served HTML
 * carries no contact at all — a script injects the mailto:/tel: anchors after
 * DOMContentLoaded, exactly like the Wix/Shopify/React shells that made the
 * fetch+regex tier report no_contact on sites that DO publish contacts.
 * These tests render with the real playwright-registry Chromium; nothing is
 * mocked below the extractor.
 */

const SHELL = 'shell-blooms.e2e-fixture.in';
const ESCALATE = 'escalate-blooms.e2e-fixture.in';
const STRUCTURED = 'structured-clinic.e2e-fixture.in';
const OBFUSCATED = 'obfus-blooms.e2e-fixture.in';

/** A LocalBusiness JSON-LD card: tier-1 alone must read it, no browser. */
const structuredHtml = `<!doctype html>
<html>
  <head>
    <title>Verma Clinic</title>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "name": "Verma Clinic",
      "telephone": "+91 98220 12345",
      "address": { "@type": "PostalAddress", "addressCountry": "IN" }
    }
    </script>
  </head>
  <body>
    <h1>Welcome to our practice</h1>
  </body>
</html>`;

/** An obfuscated plain-text address: tier-1 alone must reconstruct it. */
const obfuscatedHtml = `<!doctype html>
<html>
  <head><title>Bright Petals</title></head>
  <body>
    <p>Reach the owner: info [at] ${OBFUSCATED}</p>
  </body>
</html>`;

test.describe('browser enrichment', () => {
  let fixture: { close(): Promise<void> };
  let admin: Customer;

  test.beforeAll(async () => {
    fixture = await startFixtureServer({
      [`/site/${SHELL}`]: { body: jsShellPage(SHELL) },
      [`/site/${ESCALATE}`]: { body: jsShellPage(ESCALATE) },
      [`/site/${STRUCTURED}`]: { body: structuredHtml },
      [`/site/${OBFUSCATED}`]: { body: obfuscatedHtml },
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

  test('tier-1 alone honestly reports no_contact on a JS shell', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: SHELL, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    // The served source really has nothing for regex to find — this is the
    // premise the browser tier rests on, so it is pinned as a test.
    expect(body.enrichmentStatus).toBe('no_contact');
    expect(body.contactEmails).toEqual([]);
    expect(body.contactPhones).toEqual([]);

    // The synchronous admin path never escalates; only the queue worker does.
    const stored = await leadRow(lead.id);
    expect(stored.browserAttemptedAt).toBeNull();
  });

  test('admin browser:true renders the shell and finds its contacts', async ({
    request,
  }) => {
    test.setTimeout(60_000); // first call launches Chromium
    const lead = await seedLead({ domain: SHELL, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id, {
      browser: true,
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.contactEmails).toEqual([JS_SHELL_EMAIL]);
    expect(body.contactPhones).toEqual([JS_SHELL_PHONE]);
    expect(body.enrichmentStatus).toBe('enriched');
    expect(body.browserAttemptedAt).not.toBeNull();
    // The injected number is a valid Indian mobile — libphonenumber, not a
    // prefix check, is what attributes it.
    expect(body.indiaSignals).toContain('phone_91');
    expect(body.isIndian).toBe(true);

    const stored = await leadRow(lead.id);
    expect(stored.contactEmails).toEqual([JS_SHELL_EMAIL]);
    expect(stored.contactPhones).toEqual([JS_SHELL_PHONE]);
    expect(stored.enrichmentStatus).toBe('enriched');
    expect(stored.browserAttemptedAt).not.toBeNull();
  });

  test('the worker escalates no_contact to the browser tier exactly once', async () => {
    test.setTimeout(90_000);
    const lead = await seedLead({ domain: ESCALATE, isIndian: null });

    // Queue path, not the admin endpoint: tier-1 ends no_contact, and the
    // worker (gate on via .env.e2e) queues the browser job itself.
    await enqueueEnrichLead(lead.id);

    await expect
      .poll(async () => (await leadRow(lead.id)).enrichmentStatus, {
        timeout: 45_000,
      })
      .toBe('enriched');

    const first = await leadRow(lead.id);
    expect(first.contactEmails).toEqual([JS_SHELL_EMAIL]);
    expect(first.contactPhones).toEqual([JS_SHELL_PHONE]);
    expect(first.browserAttemptedAt).not.toBeNull();
    expect(first.enrichmentAttempts).toBe(1);

    // Re-enrich through the queue. SEMANTIC CHANGE from the phase that
    // introduced this test: tier-1 now persists by UNION-merge like the
    // browser tier, so re-crawling the raw source (which shows nothing)
    // ADDS nothing instead of wiping what the rendered DOM found. The old
    // assertion here pinned the overwrite as current-not-desired behaviour;
    // it is now desired-and-fixed — a crawl can only ever add to a lead.
    await enqueueEnrichLead(lead.id);
    await expect
      .poll(async () => (await leadRow(lead.id)).enrichmentAttempts, {
        timeout: 30_000,
      })
      .toBe(2);

    // Give a wrongly-queued browser job ample time to have run…
    await new Promise((r) => setTimeout(r, 3_000));

    const second = await leadRow(lead.id);
    // …and show it never did: the lead keeps the browser run's contacts and
    // status (no downgrade to no_contact means no re-escalation trigger
    // either), and the claim timestamp is exactly the first run's — the
    // browser tier still ran once, ever.
    expect(second.enrichmentStatus).toBe('enriched');
    expect(second.contactEmails).toEqual([JS_SHELL_EMAIL]);
    expect(second.contactPhones).toEqual([JS_SHELL_PHONE]);
    expect(second.browserAttemptedAt).toBe(first.browserAttemptedAt);
  });

  test('tier-1 reads a JSON-LD contact card, no browser needed', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: STRUCTURED, isIndian: null });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.contactPhones).toEqual(['+919822012345']);
    expect(body.enrichmentStatus).toBe('enriched');
    // addressCountry IN in the site's own structured data is a strong
    // signal on its own.
    expect(body.indiaSignals).toContain('address_in');
    expect(body.isIndian).toBe(true);

    const stored = await leadRow(lead.id);
    expect(stored.contactPhones).toEqual(['+919822012345']);
    expect(stored.browserAttemptedAt, 'tier-1 did this alone').toBeNull();
  });

  test('tier-1 reconstructs an obfuscated email', async ({ request }) => {
    const lead = await seedLead({ domain: OBFUSCATED });

    const res = await enrich(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.contactEmails).toEqual([`info@${OBFUSCATED}`]);
    expect(body.enrichmentStatus).toBe('enriched');
  });
});
