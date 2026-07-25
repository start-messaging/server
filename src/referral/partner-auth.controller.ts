import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator.js';
import { PartnerAuthService } from './partner-auth.service.js';
import { PartnerLoginDto } from './dto/partner-login.dto.js';
import { PartnerRegisterDto } from './dto/partner-register.dto.js';
import { PartnerRefreshDto } from './dto/partner-refresh.dto.js';
import { PartnerJwtGuard } from './guards/partner-jwt.guard.js';
import { CurrentPartner } from './decorators/current-partner.decorator.js';

/**
 * The partner portal's own auth surface — completely separate from customer
 * (Google) auth. Marked @Public so the global customer auth guard doesn't run;
 * the authed routes below use PartnerJwtGuard instead.
 */
@ApiTags('Partner — Auth')
@Public()
@Controller('partner/auth')
export class PartnerAuthController {
  constructor(private readonly partnerAuth: PartnerAuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new affiliate partner account' })
  register(@Body() dto: PartnerRegisterDto) {
    return this.partnerAuth.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in to the partner portal' })
  login(@Body() dto: PartnerLoginDto) {
    return this.partnerAuth.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  refresh(@Body() dto: PartnerRefreshDto) {
    return this.partnerAuth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(PartnerJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current refresh token' })
  async logout(@CurrentPartner('id') partnerId: string): Promise<void> {
    await this.partnerAuth.logout(partnerId);
  }

  @Get('me')
  @UseGuards(PartnerJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated partner profile' })
  me(@CurrentPartner('id') partnerId: string) {
    return this.partnerAuth.me(partnerId);
  }
}
