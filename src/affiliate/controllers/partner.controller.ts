import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { SkipOnboarding } from '../../common/decorators/skip-onboarding.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { PartnerAuthGuard } from '../auth/partner-auth.guard.js';
import { PartnerAuthService } from '../auth/partner-auth.service.js';
import { PartnersService } from '../services/partners.service.js';
import { AffiliateLedgerService } from '../services/affiliate-ledger.service.js';
import { PartnerPayoutService } from '../services/partner-payout.service.js';
import { AffiliateSettingsService } from '../services/affiliate-settings.service.js';
import {
  CommissionListQueryDto,
  PayoutListQueryDto,
  ReferralListQueryDto,
} from '../dto/affiliate-query.dto.js';
import {
  UpdatePartnerProfileDto,
  UpdatePayoutDetailsDto,
} from '../dto/partner-profile.dto.js';
import { paginatedResponse } from '../../common/utils/pagination.util.js';

/**
 * The partner portal API.
 *
 * `@Public()` at class level disables the customer-oriented global guards;
 * PartnerAuthGuard is what actually authenticates every route here. Each
 * handler scopes its queries by the partner id taken from the token, never
 * from a parameter, so one partner cannot read another's earnings.
 */
@ApiTags('Partner')
@ApiBearerAuth()
@Public()
@SkipOnboarding()
@UseGuards(PartnerAuthGuard)
@Controller('partner')
export class PartnerController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly ledgerService: AffiliateLedgerService,
    private readonly payoutService: PartnerPayoutService,
    private readonly settingsService: AffiliateSettingsService,
    private readonly partnerAuthService: PartnerAuthService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Funnel, earnings and payout progress' })
  async dashboard(@CurrentUser('id') partnerId: string) {
    const [partner, stats, eligibility, settings] = await Promise.all([
      this.partnersService.findById(partnerId),
      this.partnersService.getStats(partnerId),
      this.payoutService.getEligibility(partnerId),
      this.settingsService.get(),
    ]);

    if (!partner) throw new NotFoundException('Partner not found');

    return {
      referralCode: partner.referralCode,
      referralLink: this.partnerAuthService.getReferralLink(
        partner.referralCode,
      ),
      stats,
      payout: {
        ...eligibility,
        // Surfaced so the portal can explain the wait rather than just showing
        // a number that never becomes payable.
        payoutDayOfMonth: settings.payoutDayOfMonth,
      },
      commission: {
        type: partner.commissionType ?? settings.defaultCommissionType,
        rate: Number(partner.commissionRate ?? settings.defaultCommissionRate),
        isCustomRate: partner.commissionType !== null,
      },
    };
  }

  @Get('trends')
  @ApiOperation({ summary: 'Daily clicks and signups' })
  async trends(
    @CurrentUser('id') partnerId: string,
    @Query('days') days?: string,
  ) {
    const parsed = Number(days);
    const window = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), 1), 90)
      : 30;

    const rows = await this.partnersService.getTrends(partnerId, window);
    return rows.map((r) => ({
      date: r.date,
      clicks: Number(r.clicks),
      signups: Number(r.signups),
    }));
  }

  @Get('referrals')
  @ApiOperation({ summary: 'Referred customers (identity masked)' })
  async referrals(
    @CurrentUser('id') partnerId: string,
    @Query() query: ReferralListQueryDto,
  ) {
    const [items, total] = await this.partnersService.getReferrals(
      partnerId,
      query.page,
      query.limit,
      query.status,
      query.shouldCount,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('commissions')
  @ApiOperation({ summary: 'Commission ledger' })
  async commissions(
    @CurrentUser('id') partnerId: string,
    @Query() query: CommissionListQueryDto,
  ) {
    const [items, total] = await this.ledgerService.listCommissions(
      partnerId,
      query.page,
      query.limit,
      query.status,
      query.shouldCount,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Payout history' })
  async payouts(
    @CurrentUser('id') partnerId: string,
    @Query() query: PayoutListQueryDto,
  ) {
    const [items, total] = await this.ledgerService.listPayouts(
      query.page,
      query.limit,
      { partnerId, status: query.status },
      query.shouldCount,
    );
    return paginatedResponse(
      items.map((p) => this.ledgerService.sanitizePayoutForPartner(p)),
      total,
      query.page,
      query.limit,
    );
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Single payout' })
  async payout(
    @CurrentUser('id') partnerId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // Scoped by partnerId so an id guessed from elsewhere returns 404 rather
    // than another partner's settlement.
    const payout = await this.ledgerService.findPayout(id, partnerId);
    return this.ledgerService.sanitizePayoutForPartner(payout);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update profile details' })
  async updateProfile(
    @CurrentUser('id') partnerId: string,
    @Body() dto: UpdatePartnerProfileDto,
  ) {
    const partner = await this.partnersService.updateProfile(partnerId, dto);
    return this.partnerAuthService.sanitize(partner);
  }

  @Patch('payout-details')
  @ApiOperation({ summary: 'Update bank or UPI payout details' })
  async updatePayoutDetails(
    @CurrentUser('id') partnerId: string,
    @Body() dto: UpdatePayoutDetailsDto,
  ) {
    const partner = await this.partnersService.updateProfile(partnerId, dto);
    return this.partnerAuthService.sanitize(partner);
  }
}
