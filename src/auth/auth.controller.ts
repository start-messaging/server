import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import type { SignupAttribution } from './auth.service.js';
import { AttributionService } from '../affiliate/services/attribution.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly attributionService: AttributionService,
  ) {}

  /**
   * Pulls referral context off the signup request.
   *
   * The code comes from the HttpOnly cookie the click endpoint set, never from
   * the request body — a client-supplied code would let anyone credit
   * themselves for a signup they had nothing to do with.
   */
  private readAttribution(req: Request): SignupAttribution {
    return {
      referralCode: this.attributionService.readCookie(req),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    };
  }

  @Post('register')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Register a new user' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.register(
      dto,
      req.ip ?? 'unknown',
      this.readAttribution(req),
    );

    res.cookie(
      'refresh_token',
      `${user.id}:${refreshToken}`,
      this.authService.getRefreshCookieOptions(),
    );

    return { accessToken, user };
  }

  @Post('google')
  @Public()
  @ApiOperation({ summary: 'Authenticate with Google ID token' })
  async googleAuth(
    @Body() dto: GoogleAuthDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user, isNewUser } =
      await this.authService.googleAuth(
        dto,
        req.ip ?? 'unknown',
        this.readAttribution(req),
      );

    res.cookie(
      'refresh_token',
      `${user.id}:${refreshToken}`,
      this.authService.getRefreshCookieOptions(),
    );

    // Passed through only when the call created the account — the dashboard
    // needs it to fire posthog.alias exactly once, on first-ever sign-in.
    return { accessToken, user, ...(isNewUser ? { isNewUser } : {}) };
  }

  @Post('login')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.login(
      dto,
      req.ip ?? 'unknown',
    );

    res.cookie(
      'refresh_token',
      `${user.id}:${refreshToken}`,
      this.authService.getRefreshCookieOptions(),
    );

    return { accessToken, user };
  }

  @Post('refresh')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Refresh access token using refresh token cookie' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = req.cookies?.refresh_token;
    if (!cookie) {
      res.clearCookie('refresh_token', { path: '/auth' });
      throw new UnauthorizedException('No refresh token');
    }

    const parsed = this.authService.parseRefreshCookie(cookie);
    if (!parsed) {
      res.clearCookie('refresh_token', { path: '/auth' });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { accessToken, refreshToken, user } =
      await this.authService.refreshTokens(
        parsed.userId,
        parsed.token,
        req.ip ?? 'unknown',
      );

    res.cookie(
      'refresh_token',
      `${user.id}:${refreshToken}`,
      this.authService.getRefreshCookieOptions(),
    );

    return { accessToken, user };
  }

  @Post('logout')
  @SkipOnboarding()
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = req.user?.id;
    if (userId) {
      await this.authService.revokeRefreshToken(userId);
    }

    res.clearCookie('refresh_token', { path: '/auth' });

    return { message: 'Logged out' };
  }
}
