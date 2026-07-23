import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReferralService } from './referral.service.js';
import { RequestPayoutDto } from './dto/request-payout.dto.js';
import { UpdatePayoutDetailsDto } from './dto/update-payout-details.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import { PartnerJwtGuard } from './guards/partner-jwt.guard.js';
import { CurrentPartner } from './decorators/current-partner.decorator.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import {
  presentCommission,
  presentPartner,
  presentPayout,
  presentReferral,
} from './referral.presenter.js';

/**
 * Partner-facing affiliate dashboard. Authenticated with the partner JWT
 * (@Public bypasses the global customer guard; PartnerJwtGuard authenticates
 * the partner). A partner is created at registration, so there is no "join".
 */
@ApiTags('Partner — Affiliate')
@ApiBearerAuth()
@Public()
@UseGuards(PartnerJwtGuard)
@Controller('partner')
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('me')
  @ApiOperation({ summary: 'My partner profile' })
  async me(@CurrentPartner('id') partnerId: string) {
    const partner = await this.referralService.getPartnerOrThrow(partnerId);
    return presentPartner(partner);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Earnings, referred users and payout eligibility' })
  stats(@CurrentPartner('id') partnerId: string) {
    return this.referralService.getStats(partnerId);
  }

  @Patch('payout-details')
  @ApiOperation({ summary: 'Update my payout destination' })
  async updatePayoutDetails(
    @CurrentPartner('id') partnerId: string,
    @Body() dto: UpdatePayoutDetailsDto,
  ) {
    const partner = await this.referralService.updatePayoutDetails(
      partnerId,
      dto.payoutDetails,
    );
    return presentPartner(partner);
  }

  @Get('referrals')
  @ApiOperation({ summary: 'My referred users (paginated)' })
  async referrals(
    @CurrentPartner('id') partnerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.referralService.listReferrals(
      partnerId,
      query.page,
      query.limit,
    );
    return paginatedResponse(
      items.map(presentReferral),
      total,
      query.page,
      query.limit,
    );
  }

  @Get('commissions')
  @ApiOperation({ summary: 'My commission ledger (paginated)' })
  async commissions(
    @CurrentPartner('id') partnerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.referralService.listCommissions(
      partnerId,
      query.page,
      query.limit,
    );
    return paginatedResponse(
      items.map(presentCommission),
      total,
      query.page,
      query.limit,
    );
  }

  @Post('payouts')
  @ApiOperation({ summary: 'Request a payout (window + thresholds enforced)' })
  async requestPayout(
    @CurrentPartner('id') partnerId: string,
    @Body() dto: RequestPayoutDto,
  ) {
    const payout = await this.referralService.requestPayout(
      partnerId,
      dto.payoutDetails,
    );
    return presentPayout(payout);
  }

  @Get('payouts')
  @ApiOperation({ summary: 'My payout requests (paginated)' })
  async payouts(
    @CurrentPartner('id') partnerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.referralService.listPayouts(
      partnerId,
      query.page,
      query.limit,
    );
    return paginatedResponse(
      items.map(presentPayout),
      total,
      query.page,
      query.limit,
    );
  }
}
