import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions } from 'express';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { PartnersService } from '../services/partners.service.js';
import { Partner, PartnerStatus } from '../entities/partner.entity.js';

/**
 * Claims in a partner access token.
 *
 * `aud: 'partner'` is a belt-and-braces check on top of the separate signing
 * secret: even if the two secrets were ever misconfigured to the same value, a
 * customer token would still be rejected here for lacking the audience.
 */
export interface PartnerJwtPayload {
  sub: string;
  email: string;
  aud: 'partner';
}

export const PARTNER_TOKEN_AUDIENCE = 'partner';
export const PARTNER_REFRESH_COOKIE = 'partner_refresh_token';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PartnerAuthService {
  private readonly googleClient: OAuth2Client | null;

  constructor(
    private readonly partnersService: PartnersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {
    const googleClientId = this.config.get<string>('google.clientId');
    this.googleClient = googleClientId
      ? new OAuth2Client(googleClientId)
      : null;
  }

  async register(data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
    companyName?: string;
  }) {
    const partner = await this.partnersService.register(data);

    // No tokens are issued here. A pending partner has nothing to log in to
    // yet, and handing out a session for an unapproved account invites
    // probing of the partner API surface.
    return {
      status: partner.status,
      message:
        'Application received. You will be notified once it has been reviewed.',
    };
  }

  async login(email: string, password: string, ip: string) {
    const partner = await this.partnersService.findByEmailWithSecret(email);

    // Compare against a dummy hash when the account does not exist, so a
    // missing email and a wrong password take the same time to answer and
    // cannot be told apart by timing.
    const hash =
      partner?.passwordHash ??
      '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const valid = await bcrypt.compare(password, hash);

    if (!partner || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.assertUsable(partner);

    await this.partnersService.recordLogin(partner.id);
    void ip;

    return this.issueTokens(partner);
  }

  /**
   * Google OAuth sign-in for the partner portal.
   *
   * If the email matches an existing active partner, sign them in.
   * If no partner exists, auto-create a pending account — the admin
   * approval flow is preserved and the partner sees a "pending" screen.
   */
  async googleAuth(idToken: string, ip: string) {
    if (!this.googleClient) {
      throw new UnauthorizedException(
        'Google authentication is not configured',
      );
    }

    const ticket = await this.googleClient
      .verifyIdToken({
        idToken,
        audience: this.config.get<string>('google.clientId'),
      })
      .catch(() => {
        throw new UnauthorizedException('Invalid Google ID token');
      });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google ID token');
    }

    const { email, given_name, family_name } = payload;

    const existing = await this.partnersService.findByEmail(email);
    if (existing) {
      if (existing.status === PartnerStatus.SUSPENDED) {
        throw new ForbiddenException('This affiliate account is suspended.');
      }
      if (existing.status === PartnerStatus.REJECTED) {
        throw new ForbiddenException(
          'Your affiliate application was not approved.',
        );
      }
      await this.partnersService.recordLogin(existing.id);
      return { ...(await this.issueTokens(existing)), isNewPartner: false };
    }

    const partner = await this.partnersService.registerFromGoogle({
      email,
      firstName: given_name ?? '',
      lastName: family_name ?? '',
    });

    return { ...(await this.issueTokens(partner)), isNewPartner: true };
  }

  /** Rejects partners who exist but must not hold a session. */

  private assertUsable(partner: Partner): void {
    if (partner.status === PartnerStatus.PENDING) {
      throw new ForbiddenException(
        'Your affiliate application is still under review.',
      );
    }
    if (partner.status === PartnerStatus.REJECTED) {
      throw new ForbiddenException(
        'Your affiliate application was not approved.',
      );
    }
    if (partner.status === PartnerStatus.SUSPENDED) {
      throw new ForbiddenException('This affiliate account is suspended.');
    }
  }

  async issueTokens(partner: Partner) {
    const payload: PartnerJwtPayload = {
      sub: partner.id,
      email: partner.email,
      aud: PARTNER_TOKEN_AUDIENCE,
    };

    const accessToken = this.jwtService.sign(payload);

    const refreshToken = randomBytes(40).toString('hex');
    await this.partnersService.updateRefreshTokenHash(
      partner.id,
      this.hashToken(refreshToken),
    );

    return {
      accessToken,
      refreshToken,
      partner: this.sanitize(partner),
    };
  }

  async refresh(partnerId: string, refreshToken: string) {
    const partner =
      await this.partnersService.findByIdWithRefreshToken(partnerId);

    if (!partner?.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const presented = this.hashToken(refreshToken);
    // Both sides are fixed-length hex digests of the same length, so a
    // constant-time comparison is meaningful here.
    if (!this.timingSafeEqual(presented, partner.refreshTokenHash)) {
      // A presented-but-wrong token means the stored one may be compromised;
      // drop it so the session cannot be resumed.
      await this.partnersService.updateRefreshTokenHash(partnerId, null);
      throw new UnauthorizedException('Invalid refresh token');
    }

    this.assertUsable(partner);
    return this.issueTokens(partner);
  }

  async logout(partnerId: string): Promise<void> {
    await this.partnersService.updateRefreshTokenHash(partnerId, null);
  }

  getRefreshCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      // Scoped to the refresh route so the token is not attached to every
      // partner API call it has no business being on.
      path: '/partner/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
  }

  /**
   * Splits the `${partnerId}:${token}` refresh cookie.
   *
   * Takes `unknown`, and validates the id half, for the same two reasons the
   * customer equivalent does — this endpoint is unauthenticated, so both were
   * reachable by anyone with curl:
   *
   *  - `cookie-parser` runs every cookie through `JSONCookies`, so a value the
   *    client prefixes with `j:` arrives already parsed. `partner_refresh_token=j%3A1`
   *    became the number 1, and `.indexOf` on it threw.
   *  - the id half goes straight into a lookup on a uuid column, so
   *    `partner_refresh_token=x:y` reached Postgres as a cast error.
   *
   * Both surfaced as a 500. A malformed cookie is a rejected credential.
   */
  parseRefreshCookie(
    cookie: unknown,
  ): { partnerId: string; token: string } | null {
    if (typeof cookie !== 'string') return null;

    const separator = cookie.indexOf(':');
    if (separator <= 0) return null;

    const partnerId = cookie.slice(0, separator);
    const token = cookie.slice(separator + 1);
    if (!token || !UUID_PATTERN.test(partnerId)) return null;

    return { partnerId, token };
  }

  /**
   * Strips secrets before a partner object crosses the network.
   *
   * Both fields are `select: false` on the entity, so they are normally absent
   * already — this is the belt to that braces, for the query builders that
   * explicitly `addSelect` them during authentication.
   */
  sanitize(partner: Partner) {
    const safe: Partial<Partner> = { ...partner };
    delete safe.passwordHash;
    delete safe.refreshTokenHash;
    // Written by admins *about* the partner — approval reasoning, fraud
    // suspicions, whatever was noted while reviewing them. It has no
    // `select: false` on the entity, so without this it rode along in every
    // login, refresh and profile response the portal makes.
    delete safe.adminNotes;

    return {
      ...safe,
      commissionRate:
        safe.commissionRate === null ? null : Number(safe.commissionRate),
      lifetimeEarnings: Number(safe.lifetimeEarnings),
      unpaidEarnings: Number(safe.unpaidEarnings),
      paidEarnings: Number(safe.paidEarnings),
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /** Public base URL a partner's referral link points at. */
  getReferralLink(referralCode: string): string {
    const base =
      this.config.get<string>('affiliate.referralBaseUrl') ??
      'https://app.startmessaging.com';
    return `${base.replace(/\/$/, '')}/sign-in?code=${referralCode}`;
  }
}
