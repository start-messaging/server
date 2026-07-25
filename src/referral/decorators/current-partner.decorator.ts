import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedPartner } from '../strategies/partner-jwt.strategy.js';

/**
 * Injects the authenticated partner (set by PartnerJwtGuard). Pass a key to
 * pluck a single field, e.g. `@CurrentPartner('id') partnerId: string`.
 */
export const CurrentPartner = createParamDecorator(
  (data: keyof AuthenticatedPartner | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const partner = request.user as AuthenticatedPartner;
    return data ? partner?.[data] : partner;
  },
);
