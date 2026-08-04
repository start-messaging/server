import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { SkipOnboarding } from '../../common/decorators/skip-onboarding.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { PartnerAuthGuard } from '../auth/partner-auth.guard.js';
import {
  PARTNER_REFRESH_COOKIE,
  PartnerAuthService,
} from '../auth/partner-auth.service.js';
import {
  PartnerGoogleAuthDto,
  PartnerLoginDto,
  PartnerRegisterDto,
} from '../dto/partner-auth.dto.js';
import { PartnersService } from '../services/partners.service.js';

/**
 * Partner portal authentication.
 *
 * Every route is `@Public()` so the app-wide customer guards stand down — a
 * partner has no row in `users` and would fail them. Authentication is then
 * enforced by PartnerAuthGuard, which validates against the separate partner
 * secret.
 */
@ApiTags('Partner Auth')
@Public()
@SkipOnboarding()
@Controller('partner/auth')
export class PartnerAuthController {
  constructor(
    private readonly partnerAuthService: PartnerAuthService,
    private readonly partnersService: PartnersService,
  ) {}

  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Apply to join the affiliate programme' })
  async register(@Body() dto: PartnerRegisterDto) {
    return this.partnerAuthService.register(dto);
  }

  @Post('google')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Partner Google OAuth sign-in' })
  async googleAuth(
    @Body() dto: PartnerGoogleAuthDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, partner, isNewPartner } =
      await this.partnerAuthService.googleAuth(dto.idToken, req.ip ?? '');

    res.cookie(
      PARTNER_REFRESH_COOKIE,
      `${partner.id}:${refreshToken}`,
      this.partnerAuthService.getRefreshCookieOptions(),
    );

    return { accessToken, partner, isNewPartner };
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Partner login' })
  async login(
    @Body() dto: PartnerLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, partner } =
      await this.partnerAuthService.login(
        dto.email,
        dto.password,
        req.ip ?? '',
      );

    res.cookie(
      PARTNER_REFRESH_COOKIE,
      `${partner.id}:${refreshToken}`,
      this.partnerAuthService.getRefreshCookieOptions(),
    );

    return { accessToken, partner };
  }

  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Exchange the refresh cookie for a new token' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[
      PARTNER_REFRESH_COOKIE
    ];
    if (!cookie) {
      throw new UnauthorizedException('No refresh token');
    }

    const parsed = this.partnerAuthService.parseRefreshCookie(cookie);
    if (!parsed) {
      res.clearCookie(PARTNER_REFRESH_COOKIE, { path: '/partner/auth' });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { accessToken, refreshToken, partner } =
      await this.partnerAuthService.refresh(parsed.partnerId, parsed.token);

    res.cookie(
      PARTNER_REFRESH_COOKIE,
      `${partner.id}:${refreshToken}`,
      this.partnerAuthService.getRefreshCookieOptions(),
    );

    return { accessToken, partner };
  }

  @Post('logout')
  @UseGuards(PartnerAuthGuard)
  @ApiOperation({ summary: 'Revoke the partner refresh token' })
  async logout(
    @CurrentUser('id') partnerId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.partnerAuthService.logout(partnerId);
    res.clearCookie(PARTNER_REFRESH_COOKIE, { path: '/partner/auth' });
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(PartnerAuthGuard)
  @ApiOperation({ summary: 'Current partner profile' })
  async me(@CurrentUser('id') partnerId: string) {
    const partner = await this.partnersService.findById(partnerId);
    if (!partner) throw new UnauthorizedException();

    return {
      ...this.partnerAuthService.sanitize(partner),
      referralLink: this.partnerAuthService.getReferralLink(
        partner.referralCode,
      ),
    };
  }
}
