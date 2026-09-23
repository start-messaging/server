import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity.js';
import { UserRole } from '../users/enums/user-role.enum.js';
import { OnboardingReminder } from '../onboarding/entities/onboarding-reminder.entity.js';
import {
  OnboardingBlockedStep,
  OnboardingReminderStage,
} from '../onboarding/enums/onboarding-reminder.enum.js';
import {
  describeOnboardingReminder,
  onboardingReminderCatalogue,
  OnboardingReminderCopy,
} from '../common/services/email.service.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import { istDayStart, parseISTDate } from '../common/utils/date.util.js';
import {
  applySort,
  paginateQueryBuilder,
  resolveSort,
  SortWhitelist,
} from '../common/utils/pagination.util.js';
import { GrowthGranularity, GrowthQueryDto } from './dto/growth-query.dto.js';
import { GrowthNotesQueryDto } from './dto/growth-notes-query.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days covered when the caller names no window at all. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Ceiling on buckets in one signup series.
 *
 * A window is two free-text dates, so `?from=1900-01-01&granularity=day` is a
 * request for forty-six thousand points — a payload no chart can draw and a
 * `generate_series` Postgres will happily materialise while holding a
 * connection. Refused with a message naming `granularity=week`, because the
 * caller who genuinely wants a decade has a way to ask for it.
 */
const MAX_BUCKETS = 400;

/** Every rate this screen reports carries its own denominator and verdict. */
export interface RateEnvelope {
  /** Percentage, one decimal place. NULL — never 0 — when nothing was measured. */
  value: number | null;
  numerator: number;
  denominator: number;
  /** False when the denominator is 0, i.e. the rate is undefined rather than low. */
  sufficient: boolean;
  /** Why the value is null, in words an operator can read. Null when it is not. */
  reason: string | null;
}

/**
 * Builds a rate that can say "undefined" instead of lying about zero.
 *
 * The single defect this whole envelope exists to stop: a window with no
 * signups rendering "0% called". Nobody was called because nobody signed up,
 * and an operator who reads that as "the calling team did nothing this month"
 * acts on it. The SQL already returns NULL through `NULLIF` on the denominator;
 * the denominator is re-checked here so that a future refactor that drops the
 * NULLIF cannot quietly turn a null back into a 0 on the way out.
 */
function rateEnvelope(
  rawValue: unknown,
  numerator: number,
  denominator: number,
  reason: string,
): RateEnvelope {
  const sufficient = denominator > 0;
  const parsed =
    rawValue === null || rawValue === undefined ? null : Number(rawValue);

  return {
    value: sufficient ? parsed : null,
    numerator,
    denominator,
    sufficient,
    reason: sufficient ? null : reason,
  };
}

/** pg hands bigints back as strings; this is formatting, not arithmetic. */
function int(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export interface GrowthWindow {
  from: string;
  /** Exclusive. Named so the panel never has to guess whether the last day counts. */
  toExclusive: string;
  granularity: GrowthGranularity;
  buckets: number;
  timezone: 'Asia/Kolkata';
  /** True when the caller supplied neither bound and got the default window. */
  defaulted: boolean;
}

export interface FunnelStage {
  key: string;
  label: string;
  /** Accounts that cleared this gate AND every gate before it. Monotone by construction. */
  reached: number;
  /**
   * Accounts matching this stage's own condition, ignoring the earlier gates.
   *
   * Published beside `reached` because they disagree on real data — sm_db has
   * an approved account whose mobile was never marked verified — and an
   * operator comparing this screen against a filtered user list deserves to see
   * that rather than conclude one of the two is broken.
   */
  matched: number;
  lostFromPrevious: number;
  conversionFromPrevious: RateEnvelope;
  conversionFromSignup: RateEnvelope;
}

const FUNNEL_LABELS: Record<string, string> = {
  signed_up: 'Signed up',
  mobile_verified: 'Mobile verified',
  kyc_submitted: 'KYC submitted',
  kyc_approved: 'KYC approved',
  first_message: 'Sent a first message',
};

/** Sort keys the call-notes list may order by. */
const NOTES_SORT_WHITELIST: SortWhitelist = {
  called_at: 'user.adminLastCalledAt',
  signed_up_at: 'user.createdAt',
  name: ['user.firstName', 'user.lastName'],
  email: 'user.email',
};

/**
 * The admin growth screen: who signed up, where they stalled, who called them,
 * and what we emailed them.
 *
 * Three rules run through every query here and none of them are stylistic:
 *
 *  1. `role = 'customer'`. A screen about signups that counts its own admins
 *     reports four accounts that never signed up for anything. sm_db has four.
 *
 *  2. Call coverage is measured on `adminLastCalledAt`, never on
 *     `adminCallNotes`. Every noted account has a timestamp, but 40 called
 *     accounts have no note — counting notes drops those 40 real calls and
 *     reports 38.8% where the truth is 49.0%.
 *
 *  3. Rates come back as envelopes with a null value when the denominator is
 *     zero. See `rateEnvelope`.
 */
@Injectable()
export class GrowthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(OnboardingReminder)
    private readonly remindersRepository: Repository<OnboardingReminder>,
  ) {}

  /**
   * Resolves the requested window to a half-open `[from, toExclusive)` interval.
   *
   * A bare `YYYY-MM-DD` is an IST calendar day, not midnight UTC. Treating
   * `to=2026-07-26` as an instant silently drops that entire day from the
   * report, which is the sort of off-by-one nobody notices until a number is
   * challenged.
   */
  private resolveWindow(query: GrowthQueryDto): GrowthWindow & {
    fromAt: Date;
    toAt: Date;
  } {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const defaulted = !query.from && !query.to;

    const fromAt = query.from
      ? dateOnly.test(query.from)
        ? parseISTDate(query.from)
        : new Date(query.from)
      : istDayStart(DEFAULT_WINDOW_DAYS - 1);

    const toAt = query.to
      ? dateOnly.test(query.to)
        ? new Date(parseISTDate(query.to).getTime() + DAY_MS)
        : new Date(query.to)
      : new Date();

    const granularity: GrowthGranularity = query.granularity ?? 'day';
    const bucketMs = granularity === 'week' ? 7 * DAY_MS : DAY_MS;
    // Deliberately an over-estimate — the +1 covers a window that starts
    // mid-bucket, since the first bucket is the whole day or week the window
    // opened in. It is only ever used to refuse an absurd range before any
    // query runs; `window.buckets` in the response is the real length of the
    // series Postgres produced, so the two can never disagree on the payload.
    const estimatedBuckets = Math.max(
      0,
      Math.ceil((toAt.getTime() - fromAt.getTime()) / bucketMs) + 1,
    );

    if (estimatedBuckets > MAX_BUCKETS) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_INPUT,
        message:
          `That window is about ${estimatedBuckets} ${granularity} buckets wide; this report draws at most ${MAX_BUCKETS}. ` +
          (granularity === 'day'
            ? 'Narrow the dates, or ask for granularity=week.'
            : 'Narrow the dates.'),
      });
    }

    return {
      from: fromAt.toISOString(),
      toExclusive: toAt.toISOString(),
      granularity,
      buckets: estimatedBuckets,
      timezone: 'Asia/Kolkata',
      defaulted,
      fromAt,
      toAt,
    };
  }

  async getGrowth(query: GrowthQueryDto) {
    const window = this.resolveWindow(query);
    const range = [window.fromAt, window.toAt];

    const [
      series,
      funnelRow,
      callingRow,
      emailRows,
      emailTotals,
      recent,
      asOf,
    ] = await Promise.all([
      this.signupSeries(window.fromAt, window.toAt, window.granularity),
      this.funnelCounts(range),
      this.callingCounts(range),
      this.emailBreakdown(range),
      this.emailAllTime(),
      this.recentSends(range),
      this.asOfCounts(),
    ]);

    const funnel = this.buildFunnel(funnelRow);
    const cohort = funnel.stages[0]?.reached ?? 0;

    return {
      window: {
        from: window.from,
        toExclusive: window.toExclusive,
        granularity: window.granularity,
        buckets: series.length,
        timezone: window.timezone,
        defaulted: window.defaulted,
      },
      signups: {
        total: cohort,
        // Zero-filled: an absent bucket and a bucket of zero look identical in
        // a line chart, and the difference is exactly the thing this screen was
        // asked for. The existing dashboard trends deliberately do not fill —
        // they answer "what happened", this answers "what did not".
        series,
      },
      funnel,
      calling: this.buildCalling(callingRow, cohort),
      email: this.buildEmail(emailRows, emailTotals, recent, window),
      asOf: {
        ...asOf,
        // The one flag the panel should branch on before rendering any rate.
        // sm_db is a restored dump whose newest signup is weeks old, so the
        // default window is legitimately empty and every rate in this payload
        // is null rather than zero.
        windowHasData: cohort > 0,
      },
    };
  }

  /** The graph: signups per IST bucket, zero-filled across the whole window. */
  private async signupSeries(
    from: Date,
    to: Date,
    granularity: GrowthGranularity,
  ): Promise<{ bucket: string; count: number }[]> {
    // Interpolated, not parameterised, and safe for exactly one reason: it is
    // resolved from a closed allowlist in the DTO, never from the raw query
    // string. Postgres will not take an interval unit as a bind parameter, so
    // the alternative is two near-identical query strings.
    const unit = granularity === 'week' ? 'week' : 'day';

    const rows = await this.usersRepository.manager.query<
      { bucket: string; count: string }[]
    >(
      `
      WITH grid AS (
        SELECT generate_series(
                 date_trunc('${unit}', $1::timestamptz AT TIME ZONE 'Asia/Kolkata'),
                 ($2::timestamptz AT TIME ZONE 'Asia/Kolkata') - interval '1 microsecond',
                 interval '1 ${unit}'
               ) AS bucket
      ),
      signups AS (
        SELECT date_trunc('${unit}', u."createdAt" AT TIME ZONE 'Asia/Kolkata') AS bucket,
               count(*) AS c
          FROM users u
         WHERE u."role" = $3
           AND u."deletedAt" IS NULL
           AND u."createdAt" >= $1
           AND u."createdAt" <  $2
         GROUP BY 1
      )
      SELECT to_char(g.bucket, 'YYYY-MM-DD') AS bucket,
             COALESCE(s.c, 0)                AS "count"
        FROM grid g
        LEFT JOIN signups s ON s.bucket = g.bucket
       ORDER BY g.bucket ASC
      `,
      [from, to, UserRole.CUSTOMER],
    );

    return rows.map((r) => ({ bucket: r.bucket, count: int(r.count) }));
  }

  /**
   * The verification ladder, as one pass over the cohort.
   *
   * `reached` is a strict conjunction with every earlier stage, which is what
   * makes the ladder monotone by construction rather than monotone by luck.
   * Independent counts happen to descend on today's data; they are not
   * guaranteed to, and a funnel whose third bar is taller than its second is
   * the kind of thing that costs an afternoon.
   */
  private async funnelCounts(range: Date[]) {
    const [row] = await this.usersRepository.manager.query<
      Record<string, string | null>[]
    >(
      `
      WITH cohort AS (
        SELECT u."id",
               u."mobileVerified",
               u."kycSubmittedAt",
               u."kycStatus",
               EXISTS (SELECT 1 FROM messages m WHERE m."userId" = u."id") AS "hasSent"
          FROM users u
         WHERE u."role" = $3
           AND u."deletedAt" IS NULL
           AND u."createdAt" >= $1
           AND u."createdAt" <  $2
      ),
      counts AS (
        SELECT
          count(*)                                                   AS s0,
          count(*) FILTER (WHERE "mobileVerified")                   AS s1,
          -- "Submitted" ORs the status in rather than trusting the timestamp
          -- alone. sm_db holds an account that is kycStatus='approved' with a
          -- NULL kycSubmittedAt; on the timestamp alone it fails this stage AND
          -- every stage after it, so an APPROVED customer disappears from the
          -- funnel and reads as "never submitted KYC". A status past
          -- not_submitted is proof of submission whatever the timestamp says.
          count(*) FILTER (WHERE "mobileVerified"
                             AND ("kycSubmittedAt" IS NOT NULL
                                  OR "kycStatus" <> 'not_submitted'))  AS s2,
          count(*) FILTER (WHERE "mobileVerified"
                             AND ("kycSubmittedAt" IS NOT NULL
                                  OR "kycStatus" <> 'not_submitted')
                             AND "kycStatus" = 'approved')           AS s3,
          count(*) FILTER (WHERE "mobileVerified"
                             AND ("kycSubmittedAt" IS NOT NULL
                                  OR "kycStatus" <> 'not_submitted')
                             AND "kycStatus" = 'approved'
                             AND "hasSent")                          AS s4,
          count(*) FILTER (WHERE "mobileVerified")                   AS m1,
          count(*) FILTER (WHERE "kycSubmittedAt" IS NOT NULL
                             OR "kycStatus" <> 'not_submitted')       AS m2,
          count(*) FILTER (WHERE "kycStatus" = 'approved')           AS m3,
          count(*) FILTER (WHERE "hasSent")                          AS m4
        FROM cohort
      )
      SELECT c.*,
             -- Every rate divides in Postgres numeric with NULLIF on the
             -- denominator, so an empty stage arrives as NULL and no layer
             -- above ever has to decide what 0/0 should look like.
             ROUND(100.0 * s1 / NULLIF(s0, 0), 1) AS p1,
             ROUND(100.0 * s2 / NULLIF(s1, 0), 1) AS p2,
             ROUND(100.0 * s3 / NULLIF(s2, 0), 1) AS p3,
             ROUND(100.0 * s4 / NULLIF(s3, 0), 1) AS p4,
             ROUND(100.0 * s1 / NULLIF(s0, 0), 1) AS t1,
             ROUND(100.0 * s2 / NULLIF(s0, 0), 1) AS t2,
             ROUND(100.0 * s3 / NULLIF(s0, 0), 1) AS t3,
             ROUND(100.0 * s4 / NULLIF(s0, 0), 1) AS t4
        FROM counts c
      `,
      [range[0], range[1], UserRole.CUSTOMER],
    );

    return row ?? {};
  }

  private buildFunnel(row: Record<string, string | null>) {
    const reached = [0, 1, 2, 3, 4].map((i) => int(row[`s${i}`]));
    const matched = [reached[0], ...[1, 2, 3, 4].map((i) => int(row[`m${i}`]))];
    const keys = [
      'signed_up',
      'mobile_verified',
      'kyc_submitted',
      'kyc_approved',
      'first_message',
    ];

    const stages: FunnelStage[] = keys.map((key, i) => {
      const previous = i === 0 ? reached[0] : reached[i - 1];
      const previousLabel = i === 0 ? null : FUNNEL_LABELS[keys[i - 1]];

      return {
        key,
        label: FUNNEL_LABELS[key],
        reached: reached[i],
        matched: matched[i],
        lostFromPrevious: i === 0 ? 0 : previous - reached[i],
        conversionFromPrevious:
          i === 0
            ? rateEnvelope(
                reached[0] > 0 ? 100 : null,
                reached[0],
                reached[0],
                'No customer signed up in this window, so there is no cohort to convert.',
              )
            : rateEnvelope(
                row[`p${i}`],
                reached[i],
                previous,
                `No account reached "${previousLabel}" in this window, so there is nothing to convert from.`,
              ),
        conversionFromSignup:
          i === 0
            ? rateEnvelope(
                reached[0] > 0 ? 100 : null,
                reached[0],
                reached[0],
                'No customer signed up in this window, so there is no cohort to convert.',
              )
            : rateEnvelope(
                row[`t${i}`],
                reached[i],
                reached[0],
                'No customer signed up in this window, so there is no cohort to convert.',
              ),
      };
    });

    // The largest single leak, which is the one thing an operator acts on.
    let biggestDropOff: { from: string; to: string; lost: number } | null =
      null;
    for (let i = 1; i < stages.length; i += 1) {
      if (!biggestDropOff || stages[i].lostFromPrevious > biggestDropOff.lost) {
        biggestDropOff = {
          from: stages[i - 1].key,
          to: stages[i].key,
          lost: stages[i].lostFromPrevious,
        };
      }
    }
    if (biggestDropOff && biggestDropOff.lost <= 0) biggestDropOff = null;

    return {
      stages,
      biggestDropOff,
      // Asserted rather than assumed. It cannot be false while `reached` is a
      // strict conjunction, and that is exactly why it is worth publishing: if
      // it ever comes back false the ladder has been rewritten.
      monotone: stages.every(
        (s, i) => i === 0 || s.reached <= stages[i - 1].reached,
      ),
    };
  }

  /** Calling coverage over the cohort. Measured on the timestamp, never the note. */
  private async callingCounts(range: Date[]) {
    const [row] = await this.usersRepository.manager.query<
      Record<string, string | Date | null>[]
    >(
      `
      WITH cohort AS (
        SELECT u."adminLastCalledAt", u."adminCallNotes"
          FROM users u
         WHERE u."role" = $3
           AND u."deletedAt" IS NULL
           AND u."createdAt" >= $1
           AND u."createdAt" <  $2
      ),
      counts AS (
        SELECT
          count(*)                                                     AS cohort,
          count(*) FILTER (WHERE "adminLastCalledAt" IS NOT NULL)      AS called,
          count(*) FILTER (WHERE btrim(COALESCE("adminCallNotes",''))
                                 <> '')                                AS with_notes,
          count(*) FILTER (WHERE btrim(COALESCE("adminCallNotes",'')) <> ''
                             AND "adminLastCalledAt" IS NULL)          AS noted_without_call,
          max("adminLastCalledAt")                                     AS last_called_at
        FROM cohort
      )
      SELECT c.*,
             ROUND(100.0 * called     / NULLIF(cohort, 0), 1) AS coverage_pct,
             ROUND(100.0 * with_notes / NULLIF(called, 0), 1) AS note_pct,
             floor(EXTRACT(EPOCH FROM (now() - last_called_at)) / 86400) AS stale_days
        FROM counts c
      `,
      [range[0], range[1], UserRole.CUSTOMER],
    );

    return row ?? {};
  }

  private buildCalling(
    row: Record<string, string | Date | null>,
    cohort: number,
  ) {
    const called = int(row.called);
    const withNotes = int(row.with_notes);

    return {
      called,
      uncalled: cohort - called,
      withNotes,
      /**
       * Non-zero means someone wrote a note without a timestamp, and the
       * coverage figure below is then an undercount. It is 0 on every row in
       * sm_db today; publishing it means a regression in the PATCH surface
       * shows up on the screen rather than as a slowly drifting number.
       */
      notedWithoutCall: int(row.noted_without_call),
      coverage: rateEnvelope(
        row.coverage_pct,
        called,
        cohort,
        'No customer signed up in this window, so there was nobody to call.',
      ),
      noteRate: rateEnvelope(
        row.note_pct,
        withNotes,
        called,
        'No call has been logged against this window, so there is nothing to have written up.',
      ),
      lastCalledAt: iso(row.last_called_at as Date | null),
      staleDays: row.stale_days === null ? null : int(row.stale_days),
      source: 'self_reported' as const,
      sourceNote:
        'adminLastCalledAt is whatever an admin PATCHed onto the account through ' +
        'PATCH /admin/users/:id, including a backdated value. It records that ' +
        'somebody said a call happened, not that one was observed.',
    };
  }

  /** stage x blockedStep x status for reminders sent inside the window. */
  private async emailBreakdown(range: Date[]) {
    return this.remindersRepository.manager.query<
      {
        stage: string;
        blockedStep: string | null;
        status: string;
        count: string;
      }[]
    >(
      `
      SELECT r."stage", r."blockedStep", r."status", count(*) AS "count"
        FROM onboarding_reminders r
       WHERE r."deletedAt" IS NULL
         -- A row is written *before* the send, so a pending or failed one has
         -- no sentAt at all. Bucketing on sentAt alone would drop every send
         -- that went wrong, which is the half of this section worth reading.
         AND COALESCE(r."sentAt", r."createdAt") >= $1
         AND COALESCE(r."sentAt", r."createdAt") <  $2
       GROUP BY 1, 2, 3
      `,
      [range[0], range[1]],
    );
  }

  /** Whether any reminder has ever existed, so "none" can be said precisely. */
  private async emailAllTime() {
    const [row] = await this.remindersRepository.manager.query<
      { total: string; sent: string; last_sent_at: Date | null }[]
    >(
      `
      SELECT count(*)                                          AS total,
             count(*) FILTER (WHERE "status" = 'sent')         AS sent,
             max("sentAt")                                     AS last_sent_at
        FROM onboarding_reminders
       WHERE "deletedAt" IS NULL
      `,
    );
    return row ?? { total: '0', sent: '0', last_sent_at: null };
  }

  /** The most recent individual sends, so "what we sent them" is readable, not just counted. */
  private async recentSends(range: Date[]) {
    return this.remindersRepository.manager.query<
      {
        id: string;
        userId: string;
        email: string | null;
        name: string | null;
        stage: string;
        blockedStep: string | null;
        status: string;
        attempts: number;
        sentAt: Date | null;
        lastError: string | null;
      }[]
    >(
      `
      SELECT r."id",
             r."userId",
             u."email",
             btrim(COALESCE(u."firstName",'') || ' ' || COALESCE(u."lastName",'')) AS name,
             r."stage",
             r."blockedStep",
             r."status",
             r."attempts",
             r."sentAt",
             r."lastError"
        FROM onboarding_reminders r
        LEFT JOIN users u ON u."id" = r."userId"
       WHERE r."deletedAt" IS NULL
         AND COALESCE(r."sentAt", r."createdAt") >= $1
         AND COALESCE(r."sentAt", r."createdAt") <  $2
       ORDER BY COALESCE(r."sentAt", r."createdAt") DESC, r."id" DESC
       LIMIT 20
      `,
      [range[0], range[1]],
    );
  }

  private buildEmail(
    rows: {
      stage: string;
      blockedStep: string | null;
      status: string;
      count: string;
    }[],
    allTime: { total: string; sent: string; last_sent_at: Date | null },
    recent: {
      id: string;
      userId: string;
      email: string | null;
      name: string | null;
      stage: string;
      blockedStep: string | null;
      status: string;
      attempts: number;
      sentAt: Date | null;
      lastError: string | null;
    }[],
    window: GrowthWindow,
  ) {
    const fold = (pick: (r: (typeof rows)[number]) => string) => {
      const out = new Map<string, number>();
      for (const r of rows) {
        const key = pick(r);
        out.set(key, (out.get(key) ?? 0) + int(r.count));
      }
      return [...out.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    };

    const total = rows.reduce((sum, r) => sum + int(r.count), 0);
    const byStatus = fold((r) => r.status);
    const statusCount = (status: string) =>
      byStatus.find((s) => s.key === status)?.count ?? 0;

    const totalEverRows = int(allTime.total);
    const none = total === 0;
    const neverAny = totalEverRows === 0;

    // Rule of this section: an empty bar chart reads as a broken render. Say it
    // in words instead, and say which kind of empty it is — "we have never sent
    // one" and "we sent none in the month you are looking at" are different
    // facts and lead to different next actions.
    let reason: string | null = null;
    if (neverAny) {
      reason =
        'No onboarding reminder email has ever been sent. The onboarding_reminders table is empty: ' +
        'the reminder sweep runs only on production, hourly from 09:00 to 20:00 IST, and writes a ' +
        'row only for an account 24-48 hours or 7-8 days old that still has a step of its own to finish.';
    } else if (none) {
      const last = iso(allTime.last_sent_at);
      reason =
        `No reminder email was sent in this window. ${totalEverRows} reminder ` +
        `${totalEverRows === 1 ? 'row exists' : 'rows exist'} in total` +
        (last ? `, most recently sent ${last}.` : '.');
    }

    return {
      totalSent: statusCount('sent'),
      /** Rows written, whatever became of them. Always >= totalSent. */
      totalRows: total,
      pending: statusCount('pending'),
      failed: statusCount('failed'),
      byStage: fold((r) => r.stage),
      byBlockedStep: fold((r) => r.blockedStep ?? 'unknown'),
      byStatus,
      /** The full cross-tab, so the panel can render stage x step without re-querying. */
      matrix: rows.map((r) => ({
        stage: r.stage,
        blockedStep: r.blockedStep ?? 'unknown',
        status: r.status,
        count: int(r.count),
      })),
      recent: recent.map((r) => ({
        id: r.id,
        userId: r.userId,
        email: r.email,
        name: r.name || null,
        stage: r.stage,
        blockedStep: r.blockedStep,
        status: r.status,
        attempts: int(r.attempts),
        sentAt: iso(r.sentAt),
        lastError: r.lastError,
        copy: this.copyFor(r.stage, r.blockedStep),
      })),
      /**
       * What each variant actually says, lifted from EmailService rather than
       * written again here. This is the part of "what we sent them" that
       * survives an empty table: with zero sends the screen can still show the
       * six mails this system is capable of putting in an inbox.
       */
      catalogue: onboardingReminderCatalogue(),
      none,
      neverAny,
      reason,
      /**
       * Counted by when the mail went out, not by when its recipient signed up.
       * A day-7 nudge for a June signup is a July send, and pinning it to the
       * cohort would answer a question nobody asked.
       */
      scope: `sends between ${window.from} and ${window.toExclusive}`,
    };
  }

  /** Resolves a stored row back to the wording that row put in an inbox. */
  private copyFor(
    stage: string,
    blockedStep: string | null,
  ): OnboardingReminderCopy | null {
    const stages = Object.values(OnboardingReminderStage) as string[];
    const steps = Object.values(OnboardingBlockedStep) as string[];
    if (!stages.includes(stage)) return null;
    // blockedStep is a plain varchar, not an enum column, so a row can carry a
    // value this build has never heard of. Returning null beats captioning a
    // send with copy it did not use.
    if (!blockedStep || !steps.includes(blockedStep)) return null;

    return describeOnboardingReminder(
      stage as OnboardingReminderStage,
      blockedStep as OnboardingBlockedStep,
    );
  }

  /** Where the data actually is, so an empty window is navigable rather than blank. */
  private async asOfCounts() {
    const [row] = await this.usersRepository.manager.query<
      {
        customers: string;
        earliest: Date | null;
        latest: Date | null;
      }[]
    >(
      `
      SELECT count(*)          AS customers,
             min(u."createdAt") AS earliest,
             max(u."createdAt") AS latest
        FROM users u
       WHERE u."role" = $1
         AND u."deletedAt" IS NULL
      `,
      [UserRole.CUSTOMER],
    );

    const latest = iso(row?.latest ?? null);
    const earliest = iso(row?.earliest ?? null);

    return {
      generatedAt: new Date().toISOString(),
      customersAllTime: int(row?.customers),
      earliestSignupAt: earliest,
      latestSignupAt: latest,
    };
  }

  /**
   * The notes themselves. Notes are rows, not a metric — the founder asked to
   * read them, so they are paginated rather than counted.
   */
  async getNotes(query: GrowthNotesQueryDto) {
    const qb = this.usersRepository
      .createQueryBuilder('user')
      // Both columns are `select: false` on the entity, so without this the
      // rows come back with the two fields this endpoint exists to show unset.
      .addSelect(['user.adminLastCalledAt', 'user.adminCallNotes'])
      .where('user.role = :role', { role: UserRole.CUSTOMER });

    // The base set is "anyone the calling team has touched" — a call OR a note,
    // not a call alone. They are the same 192 accounts in sm_db today because
    // the timestamp is a strict superset of the note, but that is a property of
    // the data, not of the schema: AdminUpdateUserDto will happily set a note
    // with no timestamp, and scoping to the timestamp would make that row
    // invisible on the one screen meant to surface it.
    qb.andWhere(
      `(user.adminLastCalledAt IS NOT NULL OR btrim(COALESCE(user.adminCallNotes, '')) <> '')`,
    );

    const noteFilter = query.noteFilter;
    if (noteFilter === true) {
      qb.andWhere(`btrim(COALESCE(user.adminCallNotes, '')) <> ''`);
    } else if (noteFilter === false) {
      // The 40-account gap: called, never written up. This is the worklist.
      qb.andWhere(`btrim(COALESCE(user.adminCallNotes, '')) = ''`);
    }

    if (query.calledSince) {
      const since = /^\d{4}-\d{2}-\d{2}$/.test(query.calledSince)
        ? parseISTDate(query.calledSince)
        : new Date(query.calledSince);
      qb.andWhere('user.adminLastCalledAt >= :since', { since });
    }

    applySort(
      qb,
      resolveSort(
        query.sortBy,
        NOTES_SORT_WHITELIST,
        'called_at',
        query.sortOrder,
      ),
    );
    // Tie-breaker: without a unique trailing key, rows sharing a timestamp can
    // reorder between page requests and get skipped or duplicated.
    qb.addOrderBy('user.id', 'DESC');

    const [items, total] = await paginateQueryBuilder(qb, {
      page: query.page,
      limit: query.limit,
      withCount: query.shouldCount,
    });

    const rows = items.map((u) => ({
      userId: u.id,
      email: u.email,
      name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null,
      calledAt: iso(u.adminLastCalledAt),
      note:
        u.adminCallNotes && u.adminCallNotes.trim() !== ''
          ? u.adminCallNotes
          : null,
      hasNote: !!(u.adminCallNotes && u.adminCallNotes.trim() !== ''),
      kycStatus: u.kycStatus,
      mobileVerified: u.mobileVerified,
      signedUpAt: iso(u.createdAt),
    }));

    return { rows, total };
  }
}
