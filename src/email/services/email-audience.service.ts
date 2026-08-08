import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { User } from '../../users/entities/user.entity.js';
import { UserRole } from '../../users/enums/user-role.enum.js';
import type { EmailAudienceFilter } from '../entities/email-campaign.entity.js';

/** One resolved person, ready to become a campaign recipient row. */
export interface AudienceContact {
  userId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

/**
 * Upper bound on a single campaign's audience.
 *
 * Not a technical limit — the queue would happily chew through more. It is a
 * blast-radius limit: a mistyped filter that matches every row should cost a
 * refused request, not a mail-out to the entire customer base that cannot be
 * recalled once the first job runs.
 */
export const MAX_AUDIENCE_SIZE = 25_000;

/**
 * Turns a segment filter, or a pasted list, into people to email.
 *
 * Segment resolution reads the customer table directly rather than going
 * through `UsersService`: the projections there are built for the admin list
 * screen and carry wallet balances, tags and KYC documents per row. For twenty
 * thousand recipients that is a great deal of work to do and immediately throw
 * away — this needs five columns.
 */
@Injectable()
export class EmailAudienceService {
  private readonly logger = new Logger(EmailAudienceService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async countSegment(filter: EmailAudienceFilter): Promise<number> {
    return this.buildSegmentQuery(filter).getCount();
  }

  /** A handful of real matches, so the composer can show who this will reach. */
  async previewSegment(
    filter: EmailAudienceFilter,
    limit = 10,
  ): Promise<AudienceContact[]> {
    const rows = await this.buildSegmentQuery(filter)
      .orderBy('u.createdAt', 'DESC')
      .take(limit)
      .getMany();

    return rows.map((u) => this.toContact(u));
  }

  /**
   * Walks the whole segment in batches.
   *
   * Keyset pagination on the primary key rather than OFFSET. Offset would
   * re-scan and discard every earlier row on each page — quadratic over a large
   * audience — and, worse, a signup landing mid-walk shifts every subsequent
   * page by one, which silently skips a real customer.
   */
  async eachSegmentBatch(
    filter: EmailAudienceFilter,
    batchSize: number,
    handle: (batch: AudienceContact[]) => Promise<void>,
  ): Promise<number> {
    let lastId: string | null = null;
    let total = 0;

    for (;;) {
      const qb = this.buildSegmentQuery(filter)
        .orderBy('u.id', 'ASC')
        .take(batchSize);

      if (lastId) qb.andWhere('u.id > :lastId', { lastId });

      const rows = await qb.getMany();
      if (rows.length === 0) break;

      await handle(rows.map((u) => this.toContact(u)));

      total += rows.length;
      lastId = rows[rows.length - 1].id;

      if (rows.length < batchSize) break;
      if (total >= MAX_AUDIENCE_SIZE) {
        this.logger.warn(
          `Audience truncated at ${MAX_AUDIENCE_SIZE}; filter matched more.`,
        );
        break;
      }
    }

    return total;
  }

  /**
   * Parses addresses a human pasted in.
   *
   * Accepts the shapes people actually paste — one per line, comma or
   * semicolon separated, `Name <email>`, or a CSV column — because the
   * alternative is an admin hand-editing a list into whatever single format we
   * decided to accept.
   */
  parseManualRecipients(raw: string): AudienceContact[] {
    const seen = new Set<string>();
    const contacts: AudienceContact[] = [];

    const tokens = raw
      .split(/[\n,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    for (const token of tokens) {
      // `Ravi Sharma <ravi@acme.in>` — capture both halves.
      const angled = /^(.*?)<\s*([^>\s]+)\s*>$/.exec(token);
      const name = angled ? angled[1].trim().replace(/^["']|["']$/g, '') : '';
      const email = (angled ? angled[2] : token).trim().toLowerCase();

      if (!this.isPlausibleEmail(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);

      const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);

      contacts.push({
        userId: null,
        email,
        firstName: firstName ?? null,
        lastName: rest.length ? rest.join(' ') : null,
        companyName: null,
      });
    }

    return contacts;
  }

  /**
   * Links pasted addresses to accounts where one exists.
   *
   * A lead who already signed up should show up in the campaign as that
   * customer — so their name merges correctly, and so the analytics screen can
   * link straight through to the account rather than showing a bare address.
   */
  async enrichFromUsers(
    contacts: AudienceContact[],
  ): Promise<AudienceContact[]> {
    if (contacts.length === 0) return contacts;

    const emails = contacts.map((c) => c.email);
    const matched = new Map<string, User>();

    const CHUNK = 1_000;
    for (let i = 0; i < emails.length; i += CHUNK) {
      const rows = await this.users
        .createQueryBuilder('u')
        .where('LOWER(u.email) IN (:...emails)', {
          emails: emails.slice(i, i + CHUNK),
        })
        .getMany();
      rows.forEach((u) => matched.set(u.email.toLowerCase(), u));
    }

    return contacts.map((c) => {
      const user = matched.get(c.email);
      if (!user) return c;
      return {
        userId: user.id,
        email: c.email,
        // What the admin typed wins over the account record: they may be
        // correcting a name the customer entered badly at signup.
        firstName: c.firstName ?? user.firstName ?? null,
        lastName: c.lastName ?? user.lastName ?? null,
        companyName: c.companyName ?? user.companyName ?? null,
      };
    });
  }

  private buildSegmentQuery(
    filter: EmailAudienceFilter,
  ): SelectQueryBuilder<User> {
    const qb = this.users
      .createQueryBuilder('u')
      .select([
        'u.id',
        'u.email',
        'u.firstName',
        'u.lastName',
        'u.companyName',
        'u.createdAt',
      ])
      // Staff accounts are never an outreach audience, and mailing your own
      // admins from a cold-email tool is how a test send becomes an incident.
      .where('u.role = :role', { role: UserRole.CUSTOMER })
      .andWhere("u.email IS NOT NULL AND u.email <> ''");

    if (filter.status === 'active') {
      qb.andWhere('u.isActive = true');
    } else if (filter.status === 'suspended') {
      qb.andWhere('u.isActive = false');
    }

    if (filter.kycStatus?.length) {
      qb.andWhere('u.kycStatus IN (:...kycStatus)', {
        kycStatus: filter.kycStatus,
      });
    }

    if (filter.country) {
      qb.andWhere('UPPER(u.country) = UPPER(:country)', {
        country: filter.country,
      });
    }

    if (filter.hasCompletedOnboarding !== undefined) {
      qb.andWhere('u.hasCompletedOnboarding = :onboarded', {
        onboarded: filter.hasCompletedOnboarding,
      });
    }

    if (filter.createdAfter) {
      qb.andWhere('u.createdAt >= :createdAfter', {
        createdAfter: filter.createdAfter,
      });
    }
    if (filter.createdBefore) {
      qb.andWhere('u.createdAt <= :createdBefore', {
        createdBefore: filter.createdBefore,
      });
    }

    if (filter.tagIds?.length) {
      // EXISTS rather than a join: joining the tag table multiplies the user
      // row once per matching tag, which would both double-count the audience
      // and mail those people twice.
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM user_tags ut
           WHERE ut."userId" = u.id AND ut."tagId" IN (:...tagIds)
         )`,
        { tagIds: filter.tagIds },
      );
    }

    if (filter.neverToppedUp) {
      qb.andWhere(
        `NOT EXISTS (
           SELECT 1 FROM payments p
           WHERE p."userId" = u.id AND p.status = 'completed'
         )`,
      );
    }

    // Anyone who has opted out is removed at the source, so a suppressed
    // address is never even counted in the audience the admin is shown.
    qb.andWhere(
      `NOT EXISTS (
         SELECT 1 FROM email_suppressions es
         WHERE es.email = LOWER(u.email) AND es."deletedAt" IS NULL
       )`,
    );

    return qb;
  }

  private toContact(user: User): AudienceContact {
    return {
      userId: user.id,
      email: user.email.toLowerCase(),
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      companyName: user.companyName ?? null,
    };
  }

  /**
   * A deliberately loose check.
   *
   * Strict RFC 5322 validation rejects addresses that work, and this list was
   * typed by an admin who can see what they pasted. The real defence against a
   * bad address is the bounce handling, not a regex.
   */
  private isPlausibleEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value) && value.length <= 320;
  }
}
