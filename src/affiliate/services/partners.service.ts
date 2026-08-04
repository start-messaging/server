import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { Partner, PartnerStatus } from '../entities/partner.entity.js';
import { Referral, ReferralStatus } from '../entities/referral.entity.js';
import {
  applySort,
  paginateQueryBuilder,
  resolveSort,
  SortWhitelist,
} from '../../common/utils/pagination.util.js';
import { COUNT_SKIPPED } from '../../common/constants/pagination.constants.js';

/** A referral as the partner is allowed to see it — customer identity masked. */
export interface PartnerReferralRow {
  id: string;
  status: ReferralStatus;
  signedUpAt: Date;
  qualifiedAt: Date | null;
  maskedEmail: string;
}

/**
 * Referral-code alphabet.
 *
 * Excludes 0/O/1/I/L and vowels: the code gets read aloud, typed from a
 * screenshot and printed on things, so visually ambiguous characters cause
 * real support load. Dropping vowels also stops the generator from producing
 * an unfortunate word by accident.
 */
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** Sort keys the admin partner list may order by. */
const PARTNER_SORT_WHITELIST: SortWhitelist = {
  created_at: 'partner.createdAt',
  name: ['partner.firstName', 'partner.lastName'],
  email: 'partner.email',
  status: 'partner.status',
  unpaid: 'partner.unpaidEarnings',
  lifetime: 'partner.lifetimeEarnings',
  last_login: 'partner.lastLoginAt',
};

export interface PartnerFilters {
  search?: string;
  status?: PartnerStatus;
}

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(
    @InjectRepository(Partner)
    private readonly partnerRepo: Repository<Partner>,
    @InjectRepository(Referral)
    private readonly referralRepo: Repository<Referral>,
    private readonly dataSource: DataSource,
  ) {}

  // ── Identity ───────────────────────────────────────────

  async register(data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
    companyName?: string;
  }): Promise<Partner> {
    const email = data.email.trim().toLowerCase();

    const existing = await this.partnerRepo.findOne({ where: { email } });
    if (existing) {
      throw new BadRequestException(
        'An affiliate account with this email already exists.',
      );
    }

    const partner = this.partnerRepo.create({
      email,
      passwordHash: await bcrypt.hash(data.password, 10),
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      phoneNumber: data.phoneNumber ?? null,
      companyName: data.companyName ?? null,
      referralCode: await this.generateUniqueCode(),
      // Approval is manual: an affiliate link that attributes real money
      // should not be mintable by anyone who can fill in a signup form.
      status: PartnerStatus.PENDING,
    });

    return this.partnerRepo.save(partner);
  }

  /**
   * Auto-registers a partner from a Google sign-in.
   *
   * A random password hash is stored so the NOT NULL constraint on
   * `passwordHash` is satisfied, but the partner can never sign in with
   * email+password — the hash is not derived from any known input.
   */
  async registerFromGoogle(data: {
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<Partner> {
    const email = data.email.trim().toLowerCase();

    const existing = await this.partnerRepo.findOne({ where: { email } });
    if (existing) {
      throw new BadRequestException(
        'An affiliate account with this email already exists.',
      );
    }

    const partner = this.partnerRepo.create({
      email,
      passwordHash: await bcrypt.hash(randomInt(2 ** 48).toString(36), 10),
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      phoneNumber: null,
      companyName: null,
      referralCode: await this.generateUniqueCode(),
      status: PartnerStatus.PENDING,
    });

    return this.partnerRepo.save(partner);
  }

  async findById(id: string): Promise<Partner | null> {
    return this.partnerRepo.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<Partner | null> {
    return this.partnerRepo.findOne({
      where: { email: email.trim().toLowerCase() },
    });
  }

  /** Includes the password hash, which is `select: false` by default. */
  async findByEmailWithSecret(email: string): Promise<Partner | null> {
    return this.partnerRepo
      .createQueryBuilder('partner')
      .addSelect('partner.passwordHash')
      .where('LOWER(partner.email) = :email', {
        email: email.trim().toLowerCase(),
      })
      .getOne();
  }

  async findByIdWithRefreshToken(id: string): Promise<Partner | null> {
    return this.partnerRepo
      .createQueryBuilder('partner')
      .addSelect('partner.refreshTokenHash')
      .where('partner.id = :id', { id })
      .getOne();
  }

  async updateRefreshTokenHash(id: string, hash: string | null): Promise<void> {
    await this.partnerRepo.update(id, { refreshTokenHash: hash });
  }

  async recordLogin(id: string): Promise<void> {
    await this.partnerRepo.update(id, { lastLoginAt: new Date() });
  }

  // ── Self-service ───────────────────────────────────────

  async updateProfile(
    id: string,
    patch: Partial<
      Pick<
        Partner,
        | 'firstName'
        | 'lastName'
        | 'phoneNumber'
        | 'companyName'
        | 'payoutMethod'
        | 'bankAccountName'
        | 'bankAccountNumber'
        | 'bankIfsc'
        | 'upiId'
        | 'pan'
      >
    >,
  ): Promise<Partner> {
    await this.partnerRepo.update(id, patch);
    const partner = await this.findById(id);
    if (!partner) throw new NotFoundException('Partner not found');
    return partner;
  }

  // ── Admin ──────────────────────────────────────────────

  async findAllForAdmin(
    page: number,
    limit: number,
    filters: PartnerFilters,
    sortBy?: string,
    sortOrder?: string,
    withCount = true,
  ): Promise<[Partner[], number]> {
    const qb = this.partnerRepo.createQueryBuilder('partner');

    const term = filters.search?.trim();
    if (term) {
      qb.andWhere(
        `(partner."firstName" ILIKE :q OR partner."lastName" ILIKE :q
          OR partner."email" ILIKE :q OR partner."companyName" ILIKE :q
          OR partner."referralCode" ILIKE :q)`,
        { q: `%${term}%` },
      );
    }

    if (filters.status) {
      qb.andWhere('partner.status = :status', { status: filters.status });
    }

    applySort(
      qb,
      resolveSort(sortBy, PARTNER_SORT_WHITELIST, 'created_at', sortOrder),
    );
    qb.addOrderBy('partner.id', 'DESC');

    return paginateQueryBuilder(qb, { page, limit, withCount });
  }

  async setStatus(
    id: string,
    status: PartnerStatus,
    adminNotes?: string,
  ): Promise<Partner> {
    const patch: Partial<Partner> = { status };
    if (adminNotes !== undefined) patch.adminNotes = adminNotes;

    // Suspending or rejecting a partner ends their session outright. The
    // strategy re-checks status on every request, so an already-issued access
    // token stops working immediately; dropping the refresh hash here closes
    // the other half, so the session cannot be renewed either. The money paths
    // are separately gated on `status = 'active'` in SQL.
    if (status !== PartnerStatus.ACTIVE) {
      patch.refreshTokenHash = null;
    }

    await this.partnerRepo.update(id, patch);
    const partner = await this.findById(id);
    if (!partner) throw new NotFoundException('Partner not found');

    this.logger.log(`Partner ${id} status set to ${status}`);
    return partner;
  }

  /**
   * Sets or clears a per-partner commission override.
   *
   * Clearing (null) makes the partner follow the global default again, which
   * is different from copying the current default onto them — a later global
   * change would not reach a partner who had been given a snapshot.
   */
  async setCommissionOverride(
    id: string,
    override: {
      commissionType: Partner['commissionType'];
      commissionRate: number | null;
    },
  ): Promise<Partner> {
    const hasType = override.commissionType != null;
    const hasRate = override.commissionRate != null;
    if (hasType !== hasRate) {
      throw new BadRequestException(
        'commissionType and commissionRate must be set or cleared together.',
      );
    }
    if (hasRate && (override.commissionRate as number) < 0) {
      throw new BadRequestException('commissionRate cannot be negative.');
    }

    await this.partnerRepo.update(id, {
      commissionType: override.commissionType,
      commissionRate: override.commissionRate,
    });
    const partner = await this.findById(id);
    if (!partner) throw new NotFoundException('Partner not found');
    return partner;
  }

  async countByStatus(status: PartnerStatus): Promise<number> {
    return this.partnerRepo.count({ where: { status } });
  }

  // ── Stats ──────────────────────────────────────────────

  /**
   * Funnel and earnings summary for a partner.
   *
   * One round trip: each figure is a scalar subquery, so the portal dashboard
   * does not fan out into half a dozen sequential queries.
   */
  async getStats(partnerId: string) {
    const [row] = await this.dataSource.query<
      {
        clicks: string;
        unique_clicks: string;
        signups: string;
        qualified: string;
        unpaid: string;
        lifetime: string;
        paid: string;
        pending_payouts: string;
      }[]
    >(
      `
      SELECT
        (SELECT COALESCE(SUM("clicks"), 0) FROM "referral_clicks"
          WHERE "partnerId" = $1) AS clicks,
        (SELECT COALESCE(SUM("uniqueClicks"), 0) FROM "referral_clicks"
          WHERE "partnerId" = $1) AS unique_clicks,
        (SELECT COUNT(*) FROM "referrals"
          WHERE "partnerId" = $1 AND "deletedAt" IS NULL) AS signups,
        (SELECT COUNT(*) FROM "referrals"
          WHERE "partnerId" = $1 AND "status" = 'qualified'
            AND "deletedAt" IS NULL) AS qualified,
        (SELECT COALESCE(SUM("amount"), 0) FROM "partner_commissions"
          WHERE "partnerId" = $1 AND "status" = 'accrued'
            AND "deletedAt" IS NULL) AS unpaid,
        (SELECT COALESCE(SUM("amount"), 0) FROM "partner_commissions"
          WHERE "partnerId" = $1 AND "status" IN ('accrued', 'paid')
            AND "deletedAt" IS NULL) AS lifetime,
        (SELECT COALESCE(SUM("amount"), 0) FROM "partner_commissions"
          WHERE "partnerId" = $1 AND "status" = 'paid'
            AND "deletedAt" IS NULL) AS paid,
        (SELECT COUNT(*) FROM "partner_payouts"
          WHERE "partnerId" = $1 AND "status" IN ('pending', 'processing')
            AND "deletedAt" IS NULL) AS pending_payouts
      `,
      [partnerId],
    );

    const clicks = Number(row?.clicks ?? 0);
    const signups = Number(row?.signups ?? 0);

    return {
      clicks,
      uniqueClicks: Number(row?.unique_clicks ?? 0),
      signups,
      qualifiedReferrals: Number(row?.qualified ?? 0),
      unpaidEarnings: Number(row?.unpaid ?? 0),
      lifetimeEarnings: Number(row?.lifetime ?? 0),
      paidEarnings: Number(row?.paid ?? 0),
      pendingPayouts: Number(row?.pending_payouts ?? 0),
      signupConversionRate: clicks > 0 ? (signups / clicks) * 100 : 0,
    };
  }

  /** Daily click/signup series for the portal chart. */
  async getTrends(partnerId: string, days = 30) {
    return this.dataSource.query<
      { date: string; clicks: string; signups: string }[]
    >(
      `
      WITH span AS (
        SELECT generate_series(
          (now() AT TIME ZONE 'Asia/Kolkata')::date - ($2::int - 1),
          (now() AT TIME ZONE 'Asia/Kolkata')::date,
          '1 day'
        )::date AS date
      )
      SELECT
        to_char(span.date, 'YYYY-MM-DD') AS date,
        COALESCE(rc."clicks", 0) AS clicks,
        COALESCE(sg.signups, 0) AS signups
      FROM span
      LEFT JOIN "referral_clicks" rc
        ON rc."partnerId" = $1 AND rc."date" = span.date
      LEFT JOIN (
        SELECT ("createdAt" AT TIME ZONE 'Asia/Kolkata')::date AS d,
               COUNT(*) AS signups
        FROM "referrals"
        WHERE "partnerId" = $1 AND "deletedAt" IS NULL
        GROUP BY 1
      ) sg ON sg.d = span.date
      ORDER BY span.date ASC
      `,
      [partnerId, days],
    );
  }

  /**
   * The partner's referral list, with customer identity minimised.
   *
   * A partner has a legitimate need to see that a referral converted, and no
   * need at all to see who it is. Emails are masked in the service rather than
   * the UI so the raw address never crosses the network boundary.
   */
  async getReferrals(
    partnerId: string,
    page: number,
    limit: number,
    status?: string,
    withCount = true,
  ): Promise<[PartnerReferralRow[], number]> {
    // A single raw query rather than entity hydration plus a second pass for
    // the joined email: getManyAndCount followed by getRawMany would run the
    // query twice and rely on the two result sets lining up positionally,
    // which they are not guaranteed to do.
    const qb = this.referralRepo
      .createQueryBuilder('referral')
      .innerJoin('referral.user', 'user')
      .select('referral.id', 'id')
      .addSelect('referral.status', 'status')
      .addSelect('referral.createdAt', 'signedUpAt')
      .addSelect('referral.qualifiedAt', 'qualifiedAt')
      .addSelect('user.email', 'email')
      .where('referral.partnerId = :partnerId', { partnerId })
      .andWhere('referral.deletedAt IS NULL');

    if (status) {
      qb.andWhere('referral.status = :status', { status });
    }

    const total = withCount ? await qb.getCount() : COUNT_SKIPPED;

    const rows = await qb
      .orderBy('referral.createdAt', 'DESC')
      .addOrderBy('referral.id', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<{
        id: string;
        status: ReferralStatus;
        signedUpAt: Date;
        qualifiedAt: Date | null;
        email: string | null;
      }>();

    return [
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        signedUpAt: r.signedUpAt,
        qualifiedAt: r.qualifiedAt,
        maskedEmail: this.maskEmail(r.email),
      })),
      total,
    ];
  }

  /** `alexander@gmail.com` → `al•••••@gmail.com`. */
  private maskEmail(email: string | null): string {
    if (!email) return '•••';
    const [local, domain] = email.split('@');
    if (!domain) return '•••';
    const head = local.slice(0, 2);
    return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
  }

  /**
   * Generates a referral code, retrying on collision.
   *
   * 28^8 is ~3.8e11, so collisions are vanishingly rare — but "rare" is not
   * "never" once you have enough partners, and a duplicate would attribute a
   * customer to the wrong person. The unique constraint is the real guarantee;
   * this loop just avoids surfacing that as an error.
   */
  private async generateUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
      ).join('');

      const taken = await this.partnerRepo.findOne({
        where: { referralCode: code },
        select: { id: true },
      });
      if (!taken) return code;
    }

    throw new Error('Could not generate a unique referral code');
  }
}
