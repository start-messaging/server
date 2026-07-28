import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { SkipOnboarding } from '../../common/decorators/skip-onboarding.decorator.js';
import { AttributionService } from '../services/attribution.service.js';
import { TrackReferralDto } from '../dto/admin-affiliate.dto.js';
import { normalizeIp } from '../../common/utils/ip.util.js';

@ApiTags('Affiliate')
@Controller('affiliate')
export class AffiliatePublicController {
  constructor(private readonly attributionService: AttributionService) {}

  /**
   * Records a referral click and drops the attribution cookie.
   *
   * Called by the customer dashboard when it sees `?ref=` in the URL. The
   * response is deliberately uniform — `{ ok: true }` whether or not the code
   * resolved — because this endpoint is unauthenticated, and one that reported
   * "unknown code" would let anyone enumerate valid partner codes.
   *
   * The referred user is never told any of this happened; there is no UI for
   * it and the cookie is HttpOnly.
   */
  @Post('track')
  @Public()
  @SkipOnboarding()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Record a referral link click (sets cookie)' })
  async track(
    @Body() dto: TrackReferralDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.attributionService.trackClick(dto.code, res, {
      ipAddress: normalizeIp(req.ip ?? ''),
      userAgent: req.headers['user-agent'],
      landingPath: dto.landingPath,
    });

    return { ok: true };
  }
}
