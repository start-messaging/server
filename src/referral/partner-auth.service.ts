import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import { PartnerLoginDto } from './dto/partner-login.dto.js';
import { PartnerRegisterDto } from './dto/partner-register.dto.js';
import {
  ReferralPartner,
  ReferralPartnerStatus,
} from './entities/referral-partner.entity.js';
import { presentPartner } from './referral.presenter.js';
import { ReferralService } from './referral.service.js';
import type { PartnerJwtPayload } from './types/partner-jwt-payload.js';

/**
 * Partner authentication — the portal's own login stack, fully independent of
 * customer (Google) auth. Email + password with an access token (short-lived,
 * partner-secret JWT) and a rotating refresh token whose SHA-256 lives on the
 * partner row. The refresh token is self-contained (`<partnerId>.<secret>`) so
 * the SPA only has to store one opaque string.
 */
@Injectable()
export class PartnerAuthService {
  private readonly logger = new Logger(PartnerAuthService.name);
  private readonly bcryptRounds: number;

  constructor(
    @InjectRepository(ReferralPartner)
    private readonly partnerRepo: Repository<ReferralPartner>,
    private readonly referralService: ReferralService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.bcryptRounds =
      this.configService.get<number>('auth.bcryptRounds') ?? 10;
  }

  async register(dto: PartnerRegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.referralService.findPartnerByEmail(email);
    if (existing) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        message: 'A partner account with this email already exists',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);
    const partner = await this.referralService.createPartnerWithCode({
      email,
      passwordHash,
      fullName: dto.fullName,
      mobileNumber: dto.mobileNumber ?? null,
    });
    this.logger.log(`Partner registered: ${partner.id}`);
    return this.buildAuthResponse(partner);
  }

  async login(dto: PartnerLoginDto) {
    const partner = await this.referralService.findPartnerByEmail(dto.email);
    if (!partner) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      });
    }
    const valid = await bcrypt.compare(dto.password, partner.passwordHash);
    if (!valid) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      });
    }
    if (partner.status !== ReferralPartnerStatus.ACTIVE) {
      throw new ForbiddenException({
        code: ErrorCodes.PARTNER_SUSPENDED,
        message: 'Your partner account is suspended',
      });
    }
    return this.buildAuthResponse(partner);
  }

  async refresh(refreshToken: string) {
    const parsed = this.parseRefreshToken(refreshToken);
    if (!parsed) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid refresh token',
      });
    }
    const partner = await this.referralService.findPartnerById(parsed.id);
    if (!partner || !partner.refreshTokenHash) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid refresh token',
      });
    }
    if (this.hashToken(parsed.secret) !== partner.refreshTokenHash) {
      // Possible token reuse — revoke the stored token.
      partner.refreshTokenHash = null;
      await this.partnerRepo.save(partner);
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid refresh token',
      });
    }
    if (partner.status !== ReferralPartnerStatus.ACTIVE) {
      partner.refreshTokenHash = null;
      await this.partnerRepo.save(partner);
      throw new ForbiddenException({
        code: ErrorCodes.PARTNER_SUSPENDED,
        message: 'Your partner account is suspended',
      });
    }
    return this.buildAuthResponse(partner);
  }

  async logout(partnerId: string): Promise<void> {
    await this.partnerRepo.update(
      { id: partnerId },
      { refreshTokenHash: null },
    );
  }

  async me(partnerId: string) {
    const partner = await this.referralService.getPartnerOrThrow(partnerId);
    return presentPartner(partner);
  }

  private async buildAuthResponse(partner: ReferralPartner) {
    const payload: PartnerJwtPayload = {
      sub: partner.id,
      email: partner.email,
      typ: 'partner',
    };
    const accessToken = this.jwtService.sign(payload);

    const secret = randomBytes(32).toString('hex');
    partner.refreshTokenHash = this.hashToken(secret);
    partner.lastLoginAt = new Date();
    await this.partnerRepo.save(partner);

    return {
      accessToken,
      refreshToken: `${partner.id}.${secret}`,
      partner: presentPartner(partner),
    };
  }

  private parseRefreshToken(
    token: string,
  ): { id: string; secret: string } | null {
    const idx = token.indexOf('.');
    if (idx === -1) return null;
    const id = token.slice(0, idx);
    const secret = token.slice(idx + 1);
    if (!id || !secret) return null;
    return { id, secret };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
