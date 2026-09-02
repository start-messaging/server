import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { chromium, Browser, Page } from 'playwright-core';

import { ErrorCodes } from '../../common/constants/error-codes.constant.js';
import { Lead } from '../entities/lead.entity.js';
import { LeadEnrichmentStatus } from '../enums/lead.enum.js';
import { parseCsvList } from '../nrd/nrd-filter.js';
import { INDIA_TOKENS_CSV } from '../nrd/tld-lists.constant.js';
import { CRAWLER_UA, unionCapped } from './lead-enrichment.service.js';
import {
  ExtractedContacts,
  extractContacts,
  indiaHintFromSignals,
  mergeExtractions,
  scoreSignals,
} from './contact-extractor.js';
import {
  BROWSER_CONCURRENCY,
  BROWSER_TIMEOUT_MS,
} from './enrich-tuning.constant.js';

/**
 * "The browser itself cannot start" — a configuration problem, distinct from
 * every per-site failure. The admin path turns this into a 503 naming the
 * knobs; a site being broken never does.
 */
class BrowserUnavailableError extends Error {}

/** How long one failed launch stands in for the next attempts. */
const LAUNCH_FAILURE_CACHE_MS = 60_000;

/**
 * The expensive enrichment tier: renders a lead's site in headless Chromium
 * and re-runs the same extractor over the DOM JavaScript built.
 *
 * Exists because many newly-registered Indian SMB sites are Wix/Shopify/React
 * shells whose contact info is not in the served HTML at all — the fetch+regex
 * tier honestly reports no_contact on sites that DO publish contacts, just
 * behind a script tag. playwright-core rather than playwright deliberately:
 * core has no postinstall browser download, so production deploys stay lean
 * and the browser binary is whatever the channel/executablePath config points
 * at on the machine that actually runs this tier.
 */
@Injectable()
export class BrowserEnrichmentService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserEnrichmentService.name);

  /** The lazy singleton browser, shared across jobs until shutdown. */
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private lastLaunchFailure: { at: number; message: string } | null = null;

  /** Semaphore state for maxConcurrency (default 1 — speed traded for reach). */
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    @InjectRepository(Lead)
    private readonly leads: Repository<Lead>,
    private readonly config: ConfigService,
  ) {}

  private get channel(): string {
    return this.config.get<string>('leads.browserEnrich.channel') ?? 'chrome';
  }

  private get executablePath(): string | undefined {
    return (
      this.config.get<string>('leads.browserEnrich.executablePath') || undefined
    );
  }

  private get timeoutMs(): number {
    return BROWSER_TIMEOUT_MS;
  }

  private get maxConcurrency(): number {
    return BROWSER_CONCURRENCY;
  }

  private get urlTemplate(): string {
    return (
      this.config.get<string>('leads.enrich.urlTemplate') ?? 'https://{domain}'
    );
  }

  /** Same list the fetch tier threads into the extractor. */
  private get indiaTokens(): string[] {
    return [...parseCsvList(INDIA_TOKENS_CSV)];
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  /**
   * Launches the browser once and reuses it. A failed launch is cached for
   * 60s: with a queue feeding this service, a broken Chromium install would
   * otherwise be re-attempted per job — a relaunch storm that helps nobody.
   * One clear error, once a minute.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (
      this.lastLaunchFailure &&
      Date.now() - this.lastLaunchFailure.at < LAUNCH_FAILURE_CACHE_MS
    ) {
      throw new BrowserUnavailableError(this.lastLaunchFailure.message);
    }

    if (!this.launching) {
      const executablePath = this.executablePath;
      const channel = this.channel;
      this.launching = chromium
        .launch({
          headless: true,
          // executablePath wins over channel; an empty channel falls through
          // to the playwright registry Chromium.
          ...(executablePath
            ? { executablePath }
            : channel
              ? { channel }
              : {}),
        })
        .then((browser) => {
          this.browser = browser;
          this.lastLaunchFailure = null;
          return browser;
        })
        .catch((err: Error) => {
          this.lastLaunchFailure = { at: Date.now(), message: err.message };
          throw new BrowserUnavailableError(err.message);
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Renders the lead's site and extracts contacts from the built DOM,
   * following at most one same-origin contact/about link if the landing page
   * yields no email.
   */
  async renderAndExtract(domain: string): Promise<ExtractedContacts> {
    await this.acquire();
    try {
      const browser = await this.getBrowser();
      // A fresh context per job: no cookies or storage carry from one
      // stranger's site to the next. Same UA as the fetch tier — rendering
      // changes our cost, not who we are.
      const context = await browser.newContext({
        userAgent: CRAWLER_UA,
        viewport: { width: 412, height: 915 },
        javaScriptEnabled: true,
      });
      try {
        // Images, media, fonts and stylesheets add nothing extractContacts
        // can read; aborting them cuts render time and bandwidth on every
        // one of a stranger's assets.
        await context.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (
            type === 'image' ||
            type === 'media' ||
            type === 'font' ||
            type === 'stylesheet'
          ) {
            return route.abort();
          }
          return route.continue();
        });

        const page = await context.newPage();
        await page.goto(this.urlTemplate.replace('{domain}', domain), {
          waitUntil: 'domcontentloaded',
          timeout: this.timeoutMs,
        });
        // Give client-side rendering a moment to settle. The catch is
        // load-bearing: SPAs with long-polling or analytics beacons never
        // reach 'networkidle', and a page that keeps chattering is still a
        // page — we extract whatever is in the DOM when the wait gives up.
        await page
          .waitForLoadState('networkidle', { timeout: 5000 })
          .catch(() => {});

        let extracted = extractContacts(await page.content(), this.indiaTokens);

        if (extracted.emails.length === 0) {
          const followed = await this.followContactLink(page);
          if (followed) extracted = mergeExtractions(extracted, followed);
        }
        return extracted;
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      this.release();
    }
  }

  /**
   * One click deeper, same origin only. A real click on the rendered anchor
   * rather than a second goto, because an SPA's contact page often exists
   * only as a client-side route — there is nothing to fetch.
   */
  private async followContactLink(
    page: Page,
  ): Promise<ExtractedContacts | null> {
    try {
      const anchors = page.locator('a[href*="contact" i], a[href*="about" i]');
      const count = Math.min(await anchors.count(), 5);
      const origin = new URL(page.url()).origin;

      for (let i = 0; i < count; i++) {
        const anchor = anchors.nth(i);
        const href = await anchor.getAttribute('href');
        if (!href) continue;
        let target: URL;
        try {
          target = new URL(href, page.url());
        } catch {
          continue;
        }
        if (target.origin !== origin) continue; // never click off-site
        if (!(await anchor.isVisible().catch(() => false))) continue;

        await anchor.click({ timeout: 3000 });
        await page
          .waitForLoadState('domcontentloaded', { timeout: 5000 })
          .catch(() => {});
        await page
          .waitForLoadState('networkidle', { timeout: 3000 })
          .catch(() => {});
        return extractContacts(await page.content(), this.indiaTokens);
      }
    } catch {
      // The landing page already rendered; a broken link must not cost us
      // what it yielded.
    }
    return null;
  }

  /**
   * Runs the browser tier for one lead and merges what it finds into the row.
   *
   * Mirrors enrichLead's contract: per-site failures are results, recorded on
   * the lead, never thrown. The one thrown failure is the browser itself
   * being unavailable — that is a deployment problem the admin needs to see
   * as a 503, not a fact about the lead.
   */
  async browserEnrichLead(leadId: string): Promise<Lead> {
    const lead = await this.leads.findOne({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lead not found',
      });
    }

    // Claim BEFORE rendering: if the render crashes the process, the mark is
    // already down and the no_contact escalation can never loop on this lead.
    lead.browserAttemptedAt = new Date();
    await this.leads.save(lead);

    let extracted: ExtractedContacts;
    try {
      extracted = await this.renderAndExtract(lead.domain);
    } catch (err) {
      if (err instanceof BrowserUnavailableError) {
        throw new ServiceUnavailableException({
          code: ErrorCodes.LEADS_BROWSER_UNAVAILABLE,
          message:
            `Headless browser unavailable: ${err.message} — check ` +
            `LEADS_BROWSER_CHANNEL (currently '${this.channel}') or ` +
            `LEADS_BROWSER_EXECUTABLE_PATH (currently ` +
            `'${this.executablePath ?? ''}').`,
        });
      }
      // A site that defeats the renderer is a result, like a site that
      // defeats fetch. Whatever status the cheap tier established stands;
      // the prefix keeps browser failures tellable from fetch failures in
      // the same column.
      const message = (err as Error).message ?? 'unknown error';
      lead.enrichmentError = `browser: ${message}`.slice(0, 2000);
      this.logger.warn(
        `Browser enrichment of ${lead.domain} failed: ${message}`,
      );
      return this.leads.save(lead);
    }

    // UNION with what the fetch tier already stored, never replacement: the
    // rendered DOM adds to the raw HTML's finds, it does not supersede them.
    // (unionCapped is shared with the fetch tier, which merges the same way.)
    lead.contactEmails = unionCapped(lead.contactEmails, extracted.emails);
    lead.contactPhones = unionCapped(lead.contactPhones, extracted.phones);
    lead.contactWhatsapp = unionCapped(
      lead.contactWhatsapp,
      extracted.whatsapp,
    );
    lead.siteTitle = lead.siteTitle ?? extracted.title;
    lead.siteDescription = lead.siteDescription ?? extracted.description;

    const signals = [
      ...new Set([...lead.qualificationSignals, ...extracted.signals]),
    ];
    lead.qualificationSignals = signals;
    lead.qualificationScore = scoreSignals(signals);

    const indiaSignals = [
      ...new Set([...lead.indiaSignals, ...extracted.indiaSignals]),
    ];
    lead.indiaSignals = indiaSignals;
    // Upgrade-only, exactly like the fetch tier: null → true, never back.
    if (lead.isIndian == null && indiaHintFromSignals(indiaSignals)) {
      lead.isIndian = true;
    }

    const foundContact =
      lead.contactEmails.length > 0 ||
      lead.contactPhones.length > 0 ||
      lead.contactWhatsapp.length > 0;
    if (foundContact) {
      lead.enrichmentStatus = LeadEnrichmentStatus.ENRICHED;
    } else if (lead.enrichmentStatus !== LeadEnrichmentStatus.ENRICHED) {
      // Never downgrade: the browser seeing nothing does not unsee what an
      // earlier crawl found.
      lead.enrichmentStatus = LeadEnrichmentStatus.NO_CONTACT;
    }
    lead.enrichedAt = new Date();
    lead.enrichmentError = null;

    return this.leads.save(lead);
  }
}
