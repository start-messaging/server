import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { UsersService } from '../users/users.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import { UserRole } from '../users/enums/user-role.enum.js';
import type { User } from '../users/entities/user.entity.js';
import type { CookieOptions } from 'express';
import { REFRESH_TOKEN_MAX_AGE_MS } from '../common/constants/app.constants.js';
import { AttributionService } from '../affiliate/services/attribution.service.js';

/** Referral context carried on a signup request, read from the cookie. */
export interface SignupAttribution {
  referralCode: string | null;
  ipAddress?: string;
  userAgent?: string;
  landingPath?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client | null;
  private readonly bcryptRounds: number;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly walletService: WalletService,
    private readonly attributionService: AttributionService,
  ) {
    const googleClientId = this.configService.get<string>('google.clientId');
    this.googleClient = googleClientId
      ? new OAuth2Client(googleClientId)
      : null;
    this.bcryptRounds =
      this.configService.get<number>('auth.bcryptRounds') ?? 10;
  }

  /**
   * Links a brand-new account to the partner whose referral cookie it carries.
   *
   * Awaited rather than fired and forgotten so the referral exists before the
   * signup response is returned — but `attributeSignup` never throws, so a
   * problem in the affiliate programme can never stop somebody creating an
   * account.
   */
  private async attribute(
    user: User,
    attribution: SignupAttribution | undefined,
  ): Promise<void> {
    if (!attribution?.referralCode) return;

    await this.attributionService.attributeSignup(
      user.id,
      user.email,
      attribution.referralCode,
      {
        ipAddress: attribution.ipAddress,
        userAgent: attribution.userAgent,
        landingPath: attribution.landingPath,
      },
    );
  }

  async register(
    dto: RegisterDto,
    ip: string,
    attribution?: SignupAttribution,
  ) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    if (dto.mobileNumber) {
      const existingMobile = await this.usersService.findByMobileNumber(
        dto.mobileNumber,
      );
      if (existingMobile) {
        throw new ConflictException('Mobile number is already registered');
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);
    const role = dto.role ?? UserRole.CUSTOMER;

    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role,
      mobileNumber: dto.mobileNumber ?? null,
      companyName: dto.companyName ?? null,
      websiteUrl: dto.websiteUrl ?? null,
      country: dto.country ?? null,
    });

    await this.walletService.credit(
      user.id,
      10,
      'Welcome credit',
      'registration',
      user.id,
    );

    await this.attribute(user, attribution);

    return this.buildAuthResponse(user, ip);
  }

  async login(dto: LoginDto, ip: string) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account uses Google sign-in. Please log in with Google.',
      );
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }

    return this.buildAuthResponse(user, ip);
  }

  async googleAuth(
    dto: GoogleAuthDto,
    ip: string,
    attribution?: SignupAttribution,
  ) {
    if (!this.googleClient) {
      throw new UnauthorizedException(
        'Google authentication is not configured',
      );
    }

    const ticket = await this.googleClient
      .verifyIdToken({
        idToken: dto.idToken,
        audience: this.configService.get<string>('google.clientId'),
      })
      .catch(() => {
        throw new UnauthorizedException('Invalid Google ID token');
      });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google ID token');
    }

    const { sub: googleId, email, given_name, family_name } = payload;

    // 1. Find by googleId
    let user = await this.usersService.findByGoogleId(googleId);
    if (user) {
      if (!user.isActive) {
        throw new UnauthorizedException('Account is suspended');
      }
      return this.buildAuthResponse(user, ip);
    }

    // 2. Find by email — link Google account
    user = await this.usersService.findByEmail(email);
    if (user) {
      if (!user.isActive) {
        throw new UnauthorizedException('Account is suspended');
      }
      await this.usersService.updateGoogleId(user.id, googleId);
      user = (await this.usersService.findById(user.id))!;
      return this.buildAuthResponse(user, ip);
    }

    // 3. New user — create with Google profile
    const role = dto.role ?? UserRole.CUSTOMER;

    user = await this.usersService.create({
      email,
      passwordHash: null,
      firstName: given_name ?? '',
      lastName: family_name ?? '',
      role,
      googleId: googleId,
      mobileNumber: null,
      companyName: null,
      websiteUrl: null,
      country: dto.country ?? null,
    });

    await this.walletService.credit(
      user.id,
      10,
      'Welcome credit',
      'registration',
      user.id,
    );

    // Only this branch attributes. The two branches above return an existing
    // account — re-attributing one would let a partner cookie an established
    // customer and take over someone else's referral.
    await this.attribute(user, attribution);

    return this.buildAuthResponse(user, ip);
  }

  async refreshTokens(userId: string, refreshToken: string, ip: string) {
    const user = await this.usersService.findByIdWithRefreshToken(userId);
    if (!user || !user.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(refreshToken);
    if (tokenHash !== user.refreshTokenHash) {
      // Possible token reuse attack — revoke stored token
      await this.usersService.updateRefreshTokenHash(userId, null);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!user.isActive) {
      await this.usersService.updateRefreshTokenHash(userId, null);
      throw new UnauthorizedException('Account is suspended');
    }

    return this.buildAuthResponse(user, ip);
  }

  async revokeRefreshToken(userId: string): Promise<void> {
    await this.usersService.updateRefreshTokenHash(userId, null);
  }

  getRefreshCookieOptions(): CookieOptions {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/auth',
      maxAge: REFRESH_TOKEN_MAX_AGE_MS,
    };
  }

  parseRefreshCookie(cookieValue: string): {
    userId: string;
    token: string;
  } | null {
    const separatorIndex = cookieValue.indexOf(':');
    if (separatorIndex === -1) return null;
    const userId = cookieValue.substring(0, separatorIndex);
    const token = cookieValue.substring(separatorIndex + 1);
    if (!userId || !token) return null;
    return { userId, token };
  }

  async buildAuthResponse(user: User, ip: string) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = this.hashToken(refreshToken);

    await Promise.all([
      this.usersService.updateRefreshTokenHash(user.id, refreshTokenHash),
      this.usersService.updateLastLogin(user.id, ip),
    ]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        mobileNumber: user.mobileNumber,
        companyName: user.companyName,
        websiteUrl: user.websiteUrl,
        hasCompletedOnboarding: user.hasCompletedOnboarding,
        isActive: user.isActive,
        country: user.country,
        kycStatus: user.kycStatus,
        mobileVerified: user.mobileVerified,
      },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
