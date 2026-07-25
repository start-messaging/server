import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReferralService } from './referral.service.js';
import { AdminPayoutQueryDto } from './dto/admin-payout-query.dto.js';
import { ApprovePayoutDto } from './dto/approve-payout.dto.js';
import { RejectPayoutDto } from './dto/reject-payout.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import { presentPayout } from './referral.presenter.js';

/** Admin surface for the affiliate program: partners + payout processing. */
@ApiTags('Admin — Affiliate')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class AdminReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('partners')
  @ApiOperation({ summary: 'List all affiliate partners (paginated)' })
  async listPartners(@Query() query: PaginationQueryDto) {
    const [items, total] = await this.referralService.listAllPartners(
      query.page,
      query.limit,
    );
    const rows = items.map((p) => ({
      id: p.id,
      partnerId: p.id,
      email: p.email,
      fullName: p.fullName,
      referralCode: p.referralCode,
      status: p.status,
      commissionPercent: p.commissionBps / 100,
      earningsBalanceMicros: Number(p.earningsBalance),
      totalEarnedMicros: Number(p.totalEarned),
      paidUsersCount: p.paidUsersCount,
      createdAt: p.createdAt,
    }));
    return paginatedResponse(rows, total, query.page, query.limit);
  }

  @Get('payouts')
  @ApiOperation({ summary: 'List payout requests (filter by status)' })
  async listPayouts(@Query() query: AdminPayoutQueryDto) {
    const [items, total] = await this.referralService.listAllPayouts(
      query.page,
      query.limit,
      query.status,
    );
    const rows = items.map((p) => ({
      ...presentPayout(p),
      partnerId: p.partnerId,
      partnerEmail: p.partner?.email ?? null,
      partnerName: p.partner?.fullName ?? null,
      payoutDetails: p.payoutDetails,
    }));
    return paginatedResponse(rows, total, query.page, query.limit);
  }

  @Patch('payouts/:id/approve')
  @ApiOperation({ summary: 'Mark a payout as paid' })
  async approve(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: ApprovePayoutDto,
  ) {
    const payout = await this.referralService.approvePayout(
      id,
      adminId,
      dto.payoutRef,
    );
    return presentPayout(payout);
  }

  @Patch('payouts/:id/reject')
  @ApiOperation({ summary: 'Reject a payout (returns funds to the partner)' })
  async reject(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: RejectPayoutDto,
  ) {
    const payout = await this.referralService.rejectPayout(
      id,
      adminId,
      dto.rejectionReason,
    );
    return presentPayout(payout);
  }
}
