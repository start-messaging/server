import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReferralService } from './referral.service.js';
import { JoinProgramDto } from './dto/join-program.dto.js';
import { RequestPayoutDto } from './dto/request-payout.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import {
  presentCommission,
  presentPayout,
  presentProfile,
  presentReferral,
} from './referral.presenter.js';

/** Partner-facing affiliate dashboard endpoints. */
@ApiTags('Affiliate / Partner')
@ApiBearerAuth()
@SkipOnboarding()
@Controller('partner')
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Post('join')
  @ApiOperation({
    summary: 'Join the affiliate program (creates a referral code)',
  })
  async join(@CurrentUser('id') userId: string, @Body() dto: JoinProgramDto) {
    const profile = await this.referralService.joinProgram(
      userId,
      dto.payoutDetails,
    );
    return presentProfile(profile);
  }

  @Get('me')
  @ApiOperation({ summary: 'My referral profile' })
  async me(@CurrentUser('id') userId: string) {
    const profile = await this.referralService.getProfileOrThrow(userId);
    return presentProfile(profile);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Earnings, referred users and payout eligibility' })
  stats(@CurrentUser('id') userId: string) {
    return this.referralService.getStats(userId);
  }

  @Get('referrals')
  @ApiOperation({ summary: 'My referred users (paginated)' })
  async referrals(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.referralService.listReferrals(
      userId,
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
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.referralService.listCommissions(
      userId,
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
    @CurrentUser('id') userId: string,
    @Body() dto: RequestPayoutDto,
  ) {
    const payout = await this.referralService.requestPayout(
      userId,
      dto.payoutDetails,
    );
    return presentPayout(payout);
  }

  @Get('payouts')
  @ApiOperation({ summary: 'My payout requests (paginated)' })
  async payouts(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.referralService.listPayouts(
      userId,
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
