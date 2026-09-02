import { createServer, Server } from 'node:http';
import {
  bullPrefix,
  redisLogicalDb,
} from '../../../src/common/constants/redis-keys.constants.js';
import { randomUUID } from 'node:crypto';
import { APIRequestContext, APIResponse } from '@playwright/test';
import { Queue } from 'bullmq';
import { sql } from '../helpers/db.js';
import { auth, unique } from '../helpers/actors.js';

/**
 * Shared fixtures for the leads / cold-outreach specs in this directory.
 *
 * The pipeline's external seams are all swapped for local ones in .env.e2e:
 * the NRD file and the crawled sites come from the fixture server below on
 * port 41100, outreach goes through the console provider, and the tracking
 * URLs point back at the API under test. Nothing in these specs touches the
 * real WhoisDS, a stranger's website, or an SMTP server — except one DNS MX
 * and one NS lookup per enrichment, which is why fixture domains are
 * unregistered ones: NXDOMAIN pins `hasMx: false`, and the empty NS answer
 * means the parking-nameserver check never fires here (that matcher is
 * unit-tested in src/leads/enrichment/parked-detector.spec.ts instead —
 * e2e'ing it would need a real parked domain's DNS).
 */

/** A well-formed uuid that no row will ever have. */
export const ABSENT_UUID = '00000000-0000-4000-8000-00000000dead';

/** Where .env.e2e points LEADS_NRD_URL_TEMPLATE / LEADS_ENRICH_URL_TEMPLATE. */
export const FIXTURE_PORT = 41100;

/** OUTREACH_DAILY_CAP in .env.e2e. The sixth send of an IST day is refused. */
export const OUTREACH_DAILY_CAP = 5;

/*
 * Scoring contract (mirrored from src/leads/enrichment/contact-extractor.ts
 * rather than imported — the e2e suite runs against dist over HTTP and
 * should not compile server sources): qualificationScore is the COUNT of
 * distinct verified signals (0–5). The SIGNAL_WEIGHTS map that used to live
 * here is gone with the weighted sum it mirrored.
 */

/** Errors are `{ code, message }` inside the global envelope's `error`. */
export async function errorOf(
  res: APIResponse,
): Promise<{ code: string; message: string }> {
  const text = await res.text();
  const body = JSON.parse(text) as {
    error?: { code: string; message: string };
  };
  if (!body.error) {
    throw new Error(`expected an error envelope, got: ${text.slice(0, 300)}`);
  }
  return body.error;
}

/** The pagination block, which `payload()` unwraps away. */
export async function paginationOf(res: APIResponse) {
  const body = (await res.json()) as {
    pagination?: {
      page: number;
      limit: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  };
  if (!body.pagination) {
    throw new Error(
      `expected a pagination block, got ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body.pagination;
}

export interface FixtureRoute {
  status?: number;
  body: string;
  contentType?: string;
}

/**
 * A plain node:http server standing in for WhoisDS and for the crawled sites.
 *
 * Exact path match only; anything else is a 404, which is itself a fixture —
 * the ingest spec asserts that a missing NRD file ends the run failed with
 * 'HTTP 404'.
 *
 * The suite is serial (workers: 1) and every spec file shares port 41100, so
 * a spec that starts this in beforeAll MUST close it in afterAll — the next
 * spec file's listen() would otherwise die on EADDRINUSE.
 */
export function startFixtureServer(
  routes: Record<string, FixtureRoute>,
): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', `http://127.0.0.1:${FIXTURE_PORT}`)
      .pathname;
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('fixture: no such route');
      return;
    }
    res.writeHead(route.status ?? 200, {
      'Content-Type': route.contentType ?? 'text/html; charset=utf-8',
    });
    res.end(route.body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FIXTURE_PORT, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
  });
}

export interface LeadRow {
  id: string;
  domain: string;
  source: string;
  registeredOn: string | null;
  score: number;
  qualificationScore: number;
  qualificationSignals: string[];
  teamRating: number | null;
  isIndian: boolean | null;
  indiaSignals: string[];
  status: string;
  liveness: string;
  livenessCheckedAt: string | null;
  livenessDetail: string | null;
  enrichmentStatus: string;
  enrichmentAttempts: number;
  enrichedAt: string | null;
  enrichmentError: string | null;
  browserAttemptedAt: string | null;
  siteTitle: string | null;
  siteDescription: string | null;
  hasMx: boolean | null;
  contactEmails: string[];
  contactPhones: string[];
  contactWhatsapp: string[];
  outreachEmail: string | null;
  outreachToken: string | null;
  outreachProviderRef: string | null;
  queuedAt: string | null;
  contactedAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  notes: string | null;
}

export interface SeedLeadOverrides {
  domain?: string;
  registeredOn?: string | null;
  score?: number;
  qualificationScore?: number;
  isIndian?: boolean | null;
  status?: string;
  /**
   * Defaults to 'unknown' like the ingest would leave it. The enrich sweep
   * claims live leads ONLY, so a spec driving the sweep path must seed
   * 'live' (or probe first); the synchronous :id/enrich endpoint is ungated.
   */
  liveness?: string;
  enrichmentStatus?: string;
  contactEmails?: string[];
  contactPhones?: string[];
  contactWhatsapp?: string[];
  siteTitle?: string | null;
  outreachEmail?: string | null;
  outreachToken?: string | null;
  contactedAt?: Date | null;
}

/**
 * Inserts a lead directly, the way the ingest would have.
 *
 * Direct SQL rather than the API because there is no admin endpoint that
 * creates a lead — the pipeline owns creation — and the specs need leads in
 * states the trigger endpoints cannot produce on demand.
 *
 * Timestamp columns come back cast to ::text so assertions compare strings;
 * node-postgres would otherwise parse `date` columns into a local-midnight
 * Date whose ISO form is off by the timezone offset.
 */
export async function seedLead(
  overrides: SeedLeadOverrides = {},
): Promise<LeadRow> {
  const domain =
    overrides.domain ?? `${unique('lead').toLowerCase()}.e2e-fixture.in`;
  const [row] = await sql<LeadRow>(
    `INSERT INTO "leads"
       ("domain", "source", "registeredOn", "score",
        "qualificationScore", "isIndian", "status", "liveness",
        "enrichmentStatus", "contactEmails", "contactPhones",
        "contactWhatsapp", "siteTitle", "outreachEmail", "outreachToken",
        "contactedAt")
     VALUES ($1, 'nrd', $2, $3, $4, $5, $6, $7::"leads_liveness_enum",
             $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
     RETURNING *, "registeredOn"::text AS "registeredOn",
               "contactedAt"::text AS "contactedAt"`,
    [
      domain,
      overrides.registeredOn ?? null,
      overrides.score ?? 0,
      overrides.qualificationScore ?? 0,
      overrides.isIndian === undefined ? null : overrides.isIndian,
      overrides.status ?? 'new',
      overrides.liveness ?? 'unknown',
      overrides.enrichmentStatus ?? 'pending',
      JSON.stringify(overrides.contactEmails ?? []),
      JSON.stringify(overrides.contactPhones ?? []),
      JSON.stringify(overrides.contactWhatsapp ?? []),
      overrides.siteTitle ?? null,
      overrides.outreachEmail ?? null,
      overrides.outreachToken ?? null,
      overrides.contactedAt ?? null,
    ],
  );
  return row;
}

/**
 * A lead the send path has already been through: contacted, with the token
 * and address a delivered email would carry. What the tracking endpoints
 * need as their starting state when a test does not want to run a real send.
 */
export async function seedContactedLead(
  overrides: SeedLeadOverrides = {},
): Promise<LeadRow> {
  return seedLead({
    status: 'contacted',
    outreachToken: randomUUID(),
    outreachEmail: `${unique('prospect').toLowerCase()}@e2e-fixture.in`,
    contactedAt: new Date(),
    ...overrides,
  });
}

/** The lead row as stored, timestamps as text for exact comparison. */
export async function leadRow(id: string): Promise<LeadRow> {
  const [row] = await sql<LeadRow>(
    `SELECT *, "registeredOn"::text AS "registeredOn",
            "queuedAt"::text AS "queuedAt",
            "contactedAt"::text AS "contactedAt",
            "openedAt"::text AS "openedAt",
            "clickedAt"::text AS "clickedAt",
            "enrichedAt"::text AS "enrichedAt",
            "livenessCheckedAt"::text AS "livenessCheckedAt",
            "browserAttemptedAt"::text AS "browserAttemptedAt"
       FROM "leads" WHERE "id" = $1`,
    [id],
  );
  return row;
}

/** A lead's outreach events, oldest first — the order things happened. */
export async function eventsOf(leadId: string) {
  return sql<{
    type: string;
    provider: string;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT "type", "provider", "payload"
       FROM "lead_outreach_events" WHERE "leadId" = $1
      ORDER BY "occurredAt" ASC, "createdAt" ASC`,
    [leadId],
  );
}

export interface IngestRunView {
  id: string;
  fileDate: string;
  status: string;
  totalDomains: number;
  matchedDomains: number;
  insertedDomains: number;
  error: string | null;
  finishedAt: string | null;
}

/**
 * Waits for one file date's ingest run to leave 'pending'.
 *
 * The trigger endpoint only enqueues; the BullMQ worker inside the API
 * process claims the run row and finishes it moments later. Polling the
 * admin listing rather than the table keeps the assertion on the surface an
 * operator would watch.
 */
export async function pollIngestRun(
  request: APIRequestContext,
  adminToken: string,
  fileDate: string,
  timeoutMs = 20_000,
): Promise<IngestRunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get('/admin/leads/ingest-runs?limit=50', {
      headers: auth(adminToken),
    });
    if (res.ok()) {
      const body = (await res.json()) as { data: IngestRunView[] };
      const run = body.data.find((r) => String(r.fileDate).startsWith(fileDate));
      if (run && run.status !== 'pending') return run;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `ingest run for ${fileDate} did not finish within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function triggerIngest(
  request: APIRequestContext,
  token: string,
  date: string,
) {
  return request.post('/admin/leads/ingest/run', {
    data: { date },
    headers: auth(token),
  });
}

export function enrich(
  request: APIRequestContext,
  token: string,
  id: string,
  body?: Record<string, unknown>,
) {
  return request.post(`/admin/leads/${id}/enrich`, {
    ...(body ? { data: body } : {}),
    headers: auth(token),
  });
}

/**
 * Adds one tier-1 enrich job to the leads queue, the way the enrich sweep
 * would — the only path where the worker's no_contact → browser escalation
 * runs (the admin endpoint is synchronous and never escalates). Job name
 * copied from LeadsJob rather than imported, same dist-over-HTTP reasoning
 * as the scoring note above.
 *
 * Where this queue lives has to stay in lockstep with app.module's BullMQ
 * factory — host/port AND the logical DB from REDIS_URL, plus the same
 * `${REDIS_KEY_PREFIX}:bull` key prefix. This helper used to drop both, which
 * matched a factory that also dropped both; now that the factory honours the
 * /14 path and .env.e2e sets REDIS_KEY_PREFIX, a job left on db 0 under bare
 * `bull` sits in a queue no worker reads: the caller's expect.poll runs out
 * against a lead nothing ever touched, with nothing naming the mismatch.
 */
export async function enqueueEnrichLead(leadId: string): Promise<void> {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const prefix = process.env.REDIS_KEY_PREFIX;
  const queue = new Queue('leads', {
    // BullMQ's own `prefix`, not ioredis keyPrefix — same reasoning as the
    // factory: keyPrefix would corrupt the Lua scripts that move jobs.
    prefix: bullPrefix(prefix),
    connection: {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      username: url.username || undefined,
      db: redisLogicalDb(url),
    },
  });
  try {
    await queue.add(
      'enrich-lead',
      { leadId },
      { removeOnComplete: true, removeOnFail: true },
    );
  } finally {
    await queue.close();
  }
}

export function queueOutreach(
  request: APIRequestContext,
  token: string,
  id: string,
  body: Record<string, unknown>,
) {
  return request.post(`/admin/leads/${id}/queue-outreach`, {
    data: body,
    headers: auth(token),
  });
}

export interface SitePageOptions {
  domain: string;
  title?: string;
  description?: string;
  /** Rendered as a mailto: anchor. Must avoid the extractor's junk list. */
  email?: string;
  /** Rendered as a tel: anchor. */
  tel?: string;
  /** Rendered as a wa.me anchor. */
  wa?: string;
  /**
   * Text phrases dropped verbatim into the page body. Since qualification
   * went structural these can only trip the INDIA detectors ('₹ 499',
   * 'INR', a city name, 'gstin', …) — a word in a <span> no longer counts
   * toward any qualification signal.
   */
  signals?: string[];
  /** Rendered as <script src="…"></script> — the payments SDK evidence. */
  scripts?: string[];
  /**
   * Rendered as plain anchors — structural href evidence (/cart,
   * play.google.com/store/apps, …). Relative paths here must avoid
   * 'contact'/'about' or they would become followPaths.
   */
  links?: string[];
  /** Renders a login form with a password input — the auth evidence. */
  passwordForm?: boolean;
  /**
   * href of a contact-page link. CRITICAL: lead-enrichment resolves
   * contactPaths against the fetched URL, and the fixture URL template puts
   * the domain in the PATH (/site/<domain>), so a relative href like
   * "contact" would resolve to /site/contact and lose the domain segment.
   * Pass the ABSOLUTE path `/site/<domain>/contact` and register that exact
   * route on the fixture server.
   */
  contactHref?: string;
}

/**
 * A homepage the enrichment crawler can chew on.
 *
 * Every phrase outside the explicit options is chosen to contain none of the
 * extractor's signal markers and nothing shaped like an email, so the
 * expected signals and contacts are exactly the ones a test passed in.
 */
export function sitePageHtml(opts: SitePageOptions): string {
  const title = opts.title ?? `${opts.domain} — Fresh Blooms`;
  const description =
    opts.description ?? `Handmade bouquets from ${opts.domain}.`;
  const anchors = [
    opts.email ? `<a href="mailto:${opts.email}">Write to us</a>` : '',
    opts.tel ? `<a href="tel:${opts.tel}">Call us</a>` : '',
    opts.wa ? `<a href="https://wa.me/${opts.wa}">Chat with us</a>` : '',
    opts.contactHref ? `<a href="${opts.contactHref}">Reach the team</a>` : '',
    ...(opts.links ?? []).map((href) => `<a href="${href}">Store link</a>`),
  ]
    .filter(Boolean)
    .join('\n    ');
  const markers = (opts.signals ?? [])
    .map((s) => `<span>${s}</span>`)
    .join('\n    ');
  const scripts = (opts.scripts ?? [])
    .map((src) => `<script src="${src}"></script>`)
    .join('\n    ');
  const passwordForm = opts.passwordForm
    ? '<form method="post"><input type="password" name="pw"></form>'
    : '';

  return `<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <meta name="description" content="${description}">
  </head>
  <body>
    <h1>Welcome to our new home</h1>
    ${anchors}
    ${markers}
    ${scripts}
    ${passwordForm}
  </body>
</html>`;
}

/**
 * A registrar parking template, as the HTML-signature detector sees one.
 * Deliberately stuffed with the REGISTRAR's own contact and structural
 * "signals" — the parked path must discard every one of them.
 */
export function parkedPageHtml(): string {
  return `<!doctype html>
<html>
  <head><title>Parked by Example Registrar</title></head>
  <body>
    <h1>This domain is parked</h1>
    <a href="mailto:support@registrar-junk.example">Contact support</a>
    <a href="tel:+919812312345">Call sales</a>
    <form action="/login"><input type="password" name="pw"></form>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <a href="/cart">Buy this domain</a>
  </body>
</html>`;
}

/**
 * A JavaScript-shell "site": the served HTML carries NO extractable contact,
 * but a script injects a mailto: anchor and a +91 tel: anchor once the DOM is
 * ready — the Wix/Shopify/React pattern the browser tier exists for.
 *
 * The address pieces are assembled at runtime ON PURPOSE: written whole, the
 * extractor's plain-text sweep would find them in the raw source and the page
 * would no longer prove anything about rendering. Every phrase avoids the
 * extractor's signal markers, so tier-1 over this source is honestly
 * no_contact with no signals.
 */
export function jsShellPage(domain: string): string {
  return `<!doctype html>
<html>
  <head><title>${domain} — Fresh Blooms</title></head>
  <body>
    <div id="root">Our studio is on its way…</div>
    <script>
      document.addEventListener('DOMContentLoaded', function () {
        var user = 'owner';
        var host = ['shell-mail', 'in'].join('.');
        var digits = ['+9198', '7654', '4321'].join('');
        var root = document.getElementById('root');
        var mail = document.createElement('a');
        mail.href = 'mail' + 'to:' + user + '@' + host;
        mail.textContent = 'Write to us';
        var call = document.createElement('a');
        call.href = 'te' + 'l:' + digits;
        call.textContent = 'Call us';
        root.appendChild(mail);
        root.appendChild(call);
      });
    </script>
  </body>
</html>`;
}

/** What jsShellPage's script injects, as the extractor will store it. */
export const JS_SHELL_EMAIL = 'owner@shell-mail.in';
export const JS_SHELL_PHONE = '+919876544321';

/** The contact-page variant: bare, with the address the homepage withheld. */
export function contactPageHtml(opts: { email: string; tel?: string }): string {
  return `<!doctype html>
<html>
  <head><title>Reach us</title></head>
  <body>
    <a href="mailto:${opts.email}">Write to us</a>
    ${opts.tel ? `<a href="tel:${opts.tel}">Call us</a>` : ''}
  </body>
</html>`;
}
