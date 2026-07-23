import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Authenticates a partner via the 'partner-jwt' passport strategy. */
@Injectable()
export class PartnerJwtGuard extends AuthGuard('partner-jwt') {}
