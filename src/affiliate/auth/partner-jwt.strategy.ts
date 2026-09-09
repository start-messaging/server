import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  PARTNER_TOKEN_AUDIENCE,
  PartnerJwtPayload,
} from './partner-auth.service.js';
import { Partner, PartnerStatus } from '../entities/partner.entity.js';

/**
 * Partner authentication, deliberately isolated from customer auth.
 *
 * Registered under its own strategy name and verified with its own secret, so
 * a customer or admin access token is structurally incapable of authenticating
 * a partner route — the signature simply will not verify.
 */
@Injectable()
export class PartnerJwtStrategy extends PassportStrategy(
  Strategy,
  'partner-jwt',
) {
  constructor(
    config: ConfigService,
    @InjectRepository(Partner)
    private readonly partnerRepo: Repository<Partner>,
  ) {
    const secret = config.get<string>('partnerJwt.secret');
    if (!secret) {
      // Failing at boot is the point: silently falling back to the customer
      // secret would erase the separation this class exists to enforce.
      throw new Error(
        'PARTNER_JWT_SECRET is required for the affiliate partner portal',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      audience: PARTNER_TOKEN_AUDIENCE,
    });
  }

  /**
   * Establishes the caller, and confirms they are still a partner.
   *
   * The status check is a database read on every partner request, which the
   * customer strategy deliberately does not do — but the two are not
   * comparable. Customer auth fronts the OTP send path, which is the highest
   * volume endpoint in the product; partner routes are a person looking at
   * their own dashboard. One primary-key lookup there is not worth optimising
   * away, and without it suspending a partner did nothing until their access
   * token expired an hour later. They could not be *paid* in that window —
   * accrual and payout selection are both gated on `status = 'active'` in SQL
   * — but they could still read their data and, more to the point, rewrite the
   * bank details a later reinstatement would pay into.
   *
   * Only `status` is selected; nothing else here needs the row.
   */
  async validate(payload: PartnerJwtPayload) {
    // Verified again in the body: `audience` above is only enforced when the
    // claim is present, so a token minted without one must not slip through.
    if (payload.aud !== PARTNER_TOKEN_AUDIENCE) {
      throw new UnauthorizedException('Invalid token audience');
    }

    const partner = await this.partnerRepo.findOne({
      where: { id: payload.sub },
      select: { id: true, status: true },
    });

    // Same answer for "deleted", "suspended" and "never existed": a token that
    // no longer corresponds to an active partner is simply not valid.
    if (!partner || partner.status !== PartnerStatus.ACTIVE) {
      throw new UnauthorizedException('Partner account is no longer active');
    }

    // `role` is here for the log and telemetry layer, not for authorisation:
    // LoggingInterceptor falls back to 'unauthenticated' when req.user carries
    // no role, so every authenticated partner request was being recorded — in
    // pino and in the PostHog/OTel attributes — as anonymous traffic while
    // still carrying the partner's real id in user.id. That makes the whole
    // affiliate portal invisible to any filter or funnel keyed on role, and
    // makes a genuinely anonymous request indistinguishable from a partner one.
    //
    // It cannot widen access: partner routes are gated by PartnerAuthGuard, and
    // RolesGuard only ever asks whether the role is one a @Roles() decorator
    // named — 'admin' or 'customer' — which 'partner' is not.
    return { id: payload.sub, email: payload.email, role: 'partner' };
  }
}
