import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { CookieOptions, Request, Response } from 'express';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { Partner, PartnerStatus } from '../entities/partner.entity.js';
import { Referral, ReferralStatus } from '../entities/referral.entity.js';
import { AffiliateSettingsService } from './affiliate-settings.service.js';

/** Name of the attribution cookie. Deliberately opaque to the visitor. */
export const REFERRAL_COOKIE = 'sm_ref';

export interface AttributionContext {
  ipAddress?: string;
  userAgent?: string;
  landingPath?: string;
}

@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    @InjectRepository(Partner)
    private readonly partnerRepo: Repository<Partner>,
    @InjectRepository(Referral)
    private readonly referralRepo: Repository<Referral>,
    private readonly settingsService: AffiliateSettingsService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis: Redis | null,
  ) {}

  /**
   * Records a click on a referral link and sets the attribution cookie.
   *
   * The cookie is set server-side and HttpOnly for two reasons: the visitor
   * must not be able to see or edit who referred them (the programme is
   * invisible to them by design), and a partner cannot forge attribution for
   * traffic they did not send by scripting `document.cookie`.
   *
   * Returns false for unknown or inactive codes without saying which — an
   * unauthenticated endpoint that distinguishes them is a free oracle for
   * enumerating valid partner codes.
   */
  async trackClick(
    code: string,
    res: Response,
    context: AttributionContext = {},
  ): Promise<boolean> {
    const settings = await this.settingsService.get();
    if (!settings.isEnabled) return false;

    const referralCode = this.normalizeCode(code);
    if (!referralCode) return false;

    const partner = await this.partnerRepo.findOne({
      where: { referralCode, status: PartnerStatus.ACTIVE },
      select: { id: true, referralCode: true },
    });
    if (!partner) return false;

    this.setCookie(res, referralCode, settings.cookieDurationDays);

    // Counting must never fail the request — a visitor's page load does not
    // depend on our analytics succeeding.
    void this.recordClick(partner.id, context).catch((err: Error) =>
      this.logger.warn(
        `Click counter failed for ${partner.id}: ${err.message}`,
      ),
    );

    return true;
  }

  /** Reads the pending attribution code from the request, if any. */
  readCookie(req: Request): string | null {
    const raw = (req.cookies as Record<string, string> | undefined)?.[
      REFERRAL_COOKIE
    ];
    return raw ? this.normalizeCode(raw) : null;
  }

  private setCookie(res: Response, code: string, days: number): void {
    const options: CookieOptions = {
      httpOnly: true,
      // Lax rather than Strict: the visitor arrives via a cross-site
      // navigation from the partner's link, and Strict would drop the cookie
      // on exactly that first request.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: days * 24 * 60 * 60 * 1000,
      path: '/',
    };
    res.cookie(REFERRAL_COOKIE, code, options);
  }

  clearCookie(res: Response): void {
    res.clearCookie(REFERRAL_COOKIE, { path: '/' });
  }

  /**
   * Links a newly registered user to the partner whose cookie they carry.
   *
   * Called from the signup paths. Never throws: a failure to attribute must
   * not prevent somebody from creating an account, so every problem is logged
   * and swallowed.
   *
   * Runs inside the caller's transaction when one is supplied, so a rolled-back
   * signup cannot leave an orphan referral pointing at a user that was
   * never created.
   */
  async attributeSignup(
    userId: string,
    email: string,
    referralCode: string | null,
    context: AttributionContext = {},
    manager?: EntityManager,
  ): Promise<Referral | null> {
    if (!referralCode) return null;

    try {
      const settings = await this.settingsService.get();
      if (!settings.isEnabled) return null;

      const partnerRepo = manager
        ? manager.getRepository(Partner)
        : this.partnerRepo;
      const referralRepo = manager
        ? manager.getRepository(Referral)
        : this.referralRepo;

      const partner = await partnerRepo.findOne({
        where: { referralCode, status: PartnerStatus.ACTIVE },
      });
      if (!partner) return null;

      // A partner must not earn commission on their own usage.
      if (partner.email.toLowerCase() === email.toLowerCase()) {
        this.logger.warn(
          `Self-referral blocked: partner ${partner.id} signed up with their own link`,
        );
        return null;
      }

      // Attribution is first-write-wins and permanent. The cookie may be
      // overwritten by a later click before signup (last touch wins), but once
      // a customer belongs to a partner they can never be re-attributed —
      // otherwise a partner could re-cookie an existing customer and take over
      // an account that is already earning for someone else.
      const existing = await referralRepo.findOne({ where: { userId } });
      if (existing) return existing;

      return await referralRepo.save(
        referralRepo.create({
          partnerId: partner.id,
          userId,
          referralCode,
          status: ReferralStatus.PENDING,
          clickedAt: new Date(),
          landingPath: context.landingPath ?? null,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent?.slice(0, 1000) ?? null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to attribute signup for user ${userId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Bumps the daily click counter for a partner.
   *
   * Upserted into a per-day row rather than appended per click: click traffic
   * is unauthenticated and unbounded, and nobody ever reads an individual
   * click. Uniqueness is counted through a short-lived Redis key so a refresh
   * loop cannot inflate the number.
   */
  private async recordClick(
    partnerId: string,
    context: AttributionContext,
  ): Promise<void> {
    const date = this.istDateString(new Date());
    let isUnique = 1;

    if (this.redis && context.ipAddress) {
      // Hashed so raw IPs are not retained in the cache layer.
      const fingerprint = createHash('sha256')
        .update(`${partnerId}:${context.ipAddress}:${context.userAgent ?? ''}`)
        .digest('hex')
        .slice(0, 32);
      const key = `affil:click:${date}:${fingerprint}`;
      const first = await this.redis.set(key, '1', 'EX', 86_400, 'NX');
      isUnique = first ? 1 : 0;
    }

    await this.referralRepo.manager.query(
      `INSERT INTO "referral_clicks" ("partnerId", "date", "clicks", "uniqueClicks")
       VALUES ($1, $2, 1, $3)
       ON CONFLICT ("partnerId", "date")
       DO UPDATE SET "clicks" = "referral_clicks"."clicks" + 1,
                     "uniqueClicks" = "referral_clicks"."uniqueClicks" + $3,
                     "updatedAt" = now()`,
      [partnerId, date, isUnique],
    );
  }

  /** Referral codes are case-insensitive and length-capped before any lookup. */
  private normalizeCode(raw: string): string | null {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,32}$/.test(code)) return null;
    return code;
  }

  private istDateString(date: Date): string {
    return new Date(date.getTime() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }
}
