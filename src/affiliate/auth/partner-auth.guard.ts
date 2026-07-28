import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guards partner routes.
 *
 * Partner controllers carry `@Public()` so the app-wide CombinedAuthGuard,
 * RolesGuard and OnboardingGuard step aside — those all reason about the
 * `users` table, which a partner has no row in. This guard then runs at
 * controller scope (global guards resolve first, controller guards second) and
 * is the only thing that admits the request.
 */
@Injectable()
export class PartnerAuthGuard extends AuthGuard('partner-jwt') {}
