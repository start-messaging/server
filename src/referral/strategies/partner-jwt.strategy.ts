import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { PartnerJwtPayload } from '../types/partner-jwt-payload.js';

export interface AuthenticatedPartner {
  id: string;
  email: string;
}

/**
 * Partner access-token strategy. Registered under a distinct name
 * ('partner-jwt') and signed with a SEPARATE secret from the customer JWT, so a
 * customer token can never authenticate a partner route (its signature fails
 * here) and vice-versa.
 */
@Injectable()
export class PartnerJwtStrategy extends PassportStrategy(
  Strategy,
  'partner-jwt',
) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('partnerJwt.secret')!,
    });
  }

  validate(payload: PartnerJwtPayload): AuthenticatedPartner {
    if (payload.typ !== 'partner') {
      throw new UnauthorizedException();
    }
    return { id: payload.sub, email: payload.email };
  }
}
