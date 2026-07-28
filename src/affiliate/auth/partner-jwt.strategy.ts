import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  PARTNER_TOKEN_AUDIENCE,
  PartnerJwtPayload,
} from './partner-auth.service.js';

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
  constructor(config: ConfigService) {
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

  validate(payload: PartnerJwtPayload) {
    // Verified again in the body: `audience` above is only enforced when the
    // claim is present, so a token minted without one must not slip through.
    if (payload.aud !== PARTNER_TOKEN_AUDIENCE) {
      throw new UnauthorizedException('Invalid token audience');
    }
    return { id: payload.sub, email: payload.email };
  }
}
