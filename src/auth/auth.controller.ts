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
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Register a new user' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } =
      await this.authService.register(dto, req.ip ?? 'unknown');

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
    const { accessToken, refreshToken, user } =
      await this.authService.googleAuth(dto, req.ip ?? 'unknown');

    res.cookie(
      'refresh_token',
      `${user.id}:${refreshToken}`,
      this.authService.getRefreshCookieOptions(),
    );

    return { accessToken, user };
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
    const { accessToken, refreshToken, user } =
      await this.authService.login(dto, req.ip ?? 'unknown');

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
      await this.authService.refreshTokens(parsed.userId, parsed.token, req.ip ?? 'unknown');

    res.cookie(
      'refresh_token',
      `${user.id}:${refreshToken}`,
      this.authService.getRefreshCookieOptions(),
    );

    return { accessToken, user };
  }

  @Post('logout')
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
