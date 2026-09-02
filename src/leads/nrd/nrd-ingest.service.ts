import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import AdmZip from 'adm-zip';

import { ErrorCodes } from '../../common/constants/error-codes.constant.js';
import { Lead } from '../entities/lead.entity.js';
import { LeadIngestRun } from '../entities/lead-ingest-run.entity.js';
import { LeadIngestRunStatus } from '../enums/lead.enum.js';
import {
  classifyDomain,
  compareIngestPriority,
  parseCsvList,
} from './nrd-filter.js';
import {
  BLOCKED_TLDS_CSV,
  GENERIC_TLDS_CSV,
  INDIA_TOKENS_CSV,
  INDIAN_TLDS_CSV,
  INGEST_KEYWORDS_CSV,
} from './tld-lists.constant.js';
import { INGEST_MAX_INSERTS } from './ingest-tuning.constant.js';

/**
 * The date whose NRD file should exist by now, as an IST calendar day.
 *
 * WhoisDS publishes the file for day D on D+1, and "yesterday" has to be an
 * Asia/Kolkata yesterday, not the server's UTC one — a UTC box asking at
 * 01:00 IST would otherwise request a file a day too new and 404 all night.
 */
export function yesterdayInKolkata(): string {
  // en-CA is the locale whose date format is YYYY-MM-DD.
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString(
    'en-CA',
    { timeZone: 'Asia/Kolkata' },
  );
}

/** Rows per INSERT statement. 4 params each keeps us far from pg's 65535 cap. */
const INSERT_CHUNK = 1000;

/**
 * Hosts an admin-supplied source URL may point at: the WhoisDS origin the
 * daily template already uses, and the cenk.app mirror that serves a 60-day
 * NRD aggregate. Exact hostnames, https only — an admin-supplied fetch URL is
 * an SSRF primitive without this: the API would GET whatever address an admin
 * token names (cloud metadata endpoints, internal services) and ingest the
 * body.
 */
const ALLOWED_SOURCE_HOSTS = new Set([
  'www.whoisds.com',
  'whoisds.com',
  'dl.cenk.app',
]);

@Injectable()
export class NrdIngestService {
  private readonly logger = new Logger(NrdIngestService.name);

  constructor(
    @InjectRepository(LeadIngestRun)
    private readonly runs: Repository<LeadIngestRun>,
    @InjectRepository(Lead)
    private readonly leads: Repository<Lead>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Refuses any admin-supplied source URL that is not on the pinned
   * allowlist. Lives here rather than only in the DTO because the DTO guards
   * one route while this guards the fetch itself — a job enqueued by any
   * future path hits the same wall. The 127.0.0.1 exception is the e2e
   * fixture seam and only opens under NODE_ENV=test.
   */
  assertAllowedSourceUrl(raw: string): void {
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }

    const isTestLoopback =
      parsed !== null &&
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      this.config.get<string>('NODE_ENV') === 'test';

    const allowed =
      parsed !== null &&
      (isTestLoopback ||
        (parsed.protocol === 'https:' &&
          ALLOWED_SOURCE_HOSTS.has(parsed.hostname)));

    if (!allowed) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'url must be https on one of: www.whoisds.com, whoisds.com, dl.cenk.app',
      });
    }
  }

  /**
   * Ingests one day's NRD file. Idempotent: a completed day is never re-run,
   * while a pending/failed one is claimed again — which is what lets the
   * scheduler's hourly retry window re-fire for free until the file appears.
   *
   * `force` re-claims even a completed day. Exists because the FILTER can
   * change under a day that already ran — ingest-all widened what a file
   * yields, and every completed day before it was extracted with the old
   * gate. Safe to repeat: ON CONFLICT (domain) DO NOTHING means a re-run
   * touches no existing lead and only inserts the newly-admitted domains.
   * Admin-triggered only; the scheduler never forces.
   *
   * `sourceUrl` overrides the template for this run — the aggregate-mirror
   * import path. NOTE: an aggregate spans many registration days, so leads
   * from such a run carry an approximate registeredOn (the fileDate the admin
   * chose), not each domain's true registration date.
   */
  async runForDate(
    fileDate: string,
    sourceUrl?: string,
    force = false,
  ): Promise<LeadIngestRun> {
    const claimed = await this.claimRun(fileDate, force);
    if (!claimed) {
      // That day already completed. Return the existing run untouched.
      return (await this.runs.findOne({ where: { fileDate } }))!;
    }

    try {
      // Re-checked here even though the controller already refused bad URLs:
      // the job data crossed Redis, and the fetch is the thing that must
      // never reach an unlisted host.
      if (sourceUrl) this.assertAllowedSourceUrl(sourceUrl);
      const url = sourceUrl ?? this.buildUrl(fileDate);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        // Not a throw: a 404 just means WhoisDS hasn't published the file
        // yet, and the retry window will ask again in an hour. Recording the
        // failure keeps the runs list honest in the meantime.
        return await this.finishRun(claimed.id, {
          status: LeadIngestRunStatus.FAILED,
          error: `HTTP ${response.status}`,
        });
      }

      const body = Buffer.from(await response.arrayBuffer());
      const text = this.extractText(body);
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      // Curated data, not deployment config — see tld-lists.constant.ts.
      // parseCsvList still runs so the lists arrive lowercased, dot-stripped
      // and de-duplicated, which is what the classifier's lookups assume.
      const indianTlds = parseCsvList(INDIAN_TLDS_CSV);
      const genericTlds = parseCsvList(GENERIC_TLDS_CSV);
      const blockedTlds = parseCsvList(BLOCKED_TLDS_CSV);
      const keywords = [...parseCsvList(INGEST_KEYWORDS_CSV)];
      const indiaTokens = [...parseCsvList(INDIA_TOKENS_CSV)];

      const kept: Array<{
        domain: string;
        score: number;
        isIndian: true | null;
      }> = [];
      for (const line of lines) {
        const result = classifyDomain(line, {
          indianTlds,
          genericTlds,
          blockedTlds,
          keywords,
          indiaTokens,
        });
        // The effective TLD decided keep/drop and isIndian inside the
        // classifier; it is not persisted — the leads table dropped the
        // column as derivable-from-domain noise.
        if (result.keep && result.domain) {
          kept.push({
            domain: result.domain,
            score: result.score,
            isIndian: result.isIndian,
          });
        }
      }

      const maxInserts = INGEST_MAX_INSERTS;
      let toInsert = kept;
      if (kept.length > maxInserts) {
        this.logger.warn(
          `NRD ${fileDate}: ${kept.length} matches exceed INGEST_MAX_INSERTS=${maxInserts} ` +
          `(src/leads/nrd/ingest-tuning.constant.ts); ` +
            `inserting the ${maxInserts} highest-priority. If the filters are healthy this means ` +
            `the file was mis-parsed or poisoned — inspect it before raising the cap.`,
        );
        // Priority-sort before cutting, so the cap discards the lowest-value
        // tail (unknown-country, score-0 generic domains) and never an
        // India-confirmed or India-named one. With ingest-all the cap is a
        // poisoned-file backstop, not a curation tool — a healthy day fits
        // under it whole; only a mis-parsed or hostile file hits the cut.
        toInsert = [...kept].sort(compareIngestPriority).slice(0, maxInserts);
      }

      const inserted = await this.insertLeads(toInsert, fileDate);

      return await this.finishRun(claimed.id, {
        status: LeadIngestRunStatus.COMPLETED,
        totalDomains: lines.length,
        matchedDomains: kept.length,
        insertedDomains: inserted,
        error: null,
      });
    } catch (err) {
      const message = (err as Error).message ?? 'unknown error';
      this.logger.error(`NRD ingest for ${fileDate} failed: ${message}`);
      return await this.finishRun(claimed.id, {
        status: LeadIngestRunStatus.FAILED,
        error: message.slice(0, 2000),
      });
    }
  }

  /**
   * Claims the run row for this file date, or returns null if the day is done.
   *
   * The single statement is the arbiter: two workers claiming at once both hit
   * the unique constraint, and the DO UPDATE's WHERE refuses the one that
   * finds 'completed' already there. No application-side check could close
   * that window. Under `force` the WHERE widens to always-true — the claim
   * stays a single race-safe statement, it just also re-opens completed days.
   */
  private async claimRun(
    fileDate: string,
    force = false,
  ): Promise<{ id: string } | null> {
    const rows: Array<{ id: string }> = await this.runs.query(
      `INSERT INTO lead_ingest_runs ("fileDate", status)
       VALUES ($1, 'pending')
       ON CONFLICT ("fileDate") DO UPDATE
          SET status = 'pending', error = NULL, "updatedAt" = now()
        WHERE lead_ingest_runs.status <> 'completed' OR $2
       RETURNING id`,
      [fileDate, force],
    );
    return rows[0] ?? null;
  }

  private buildUrl(fileDate: string): string {
    const template =
      this.config.get<string>('leads.ingest.urlTemplate') ?? 'https://{date}';
    return template
      .replace(
        '{dateBase64Zip}',
        Buffer.from(`${fileDate}.zip`).toString('base64'),
      )
      .replace('{date}', fileDate);
  }

  /**
   * WhoisDS serves a zip whose single .txt holds one domain per line. A body
   * without the zip magic is treated as the text itself — the seam the tests
   * (and any future mirror serving plain text) rely on.
   */
  private extractText(body: Buffer): string {
    if (body.length >= 2 && body.subarray(0, 2).toString('latin1') === 'PK') {
      const zip = new AdmZip(body);
      const entries = zip.getEntries();
      const entry =
        entries.find((e) => e.entryName.toLowerCase().endsWith('.txt')) ??
        entries[0];
      if (!entry) return '';
      return entry.getData().toString('utf8');
    }
    return body.toString('utf8');
  }

  /** Inserts in chunks; returns how many rows were actually new. */
  private async insertLeads(
    rows: Array<{
      domain: string;
      score: number;
      isIndian: true | null;
    }>,
    fileDate: string,
  ): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const params: unknown[] = [];
      const values = chunk
        .map((row, j) => {
          // The classifier's verdict: true for Indian TLDs and India-named
          // generic domains, NULL otherwise — never false at ingest. NULL
          // stays until enrichment finds a +91 number, a GSTIN, ₹ prices…
          params.push(row.domain, fileDate, row.score, row.isIndian);
          const base = j * 4;
          return `($${base + 1}, 'nrd', $${base + 2}, $${base + 3}, $${base + 4})`;
        })
        .join(', ');

      const returned: Array<{ id: string }> = await this.leads.query(
        `INSERT INTO leads (domain, source, "registeredOn", score, "isIndian")
         VALUES ${values}
         ON CONFLICT (domain) DO NOTHING
         RETURNING id`,
        params,
      );
      inserted += returned.length;
    }
    return inserted;
  }

  private async finishRun(
    runId: string,
    patch: Partial<LeadIngestRun>,
  ): Promise<LeadIngestRun> {
    await this.runs.update(runId, { ...patch, finishedAt: new Date() });
    return (await this.runs.findOne({ where: { id: runId } }))!;
  }
}
