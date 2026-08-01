import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { paginatedResponse } from '../../common/utils/pagination.util.js';
import { AffiliateSettingsService } from '../services/affiliate-settings.service.js';
import { PartnersService } from '../services/partners.service.js';
import { AffiliateLedgerService } from '../services/affiliate-ledger.service.js';
import { PartnerPayoutService } from '../services/partner-payout.service.js';
import { CommissionAccrualService } from '../services/commission-accrual.service.js';
import { PartnerAuthService } from '../auth/partner-auth.service.js';
import { AffiliateSchedulerService } from '../queues/affiliate-scheduler.service.js';
import { PartnerStatus } from '../entities/partner.entity.js';
import {
  PartnerListQueryDto,
  PayoutListQueryDto,
} from '../dto/affiliate-query.dto.js';
import {
  BlockReferralDto,
  ReverseCommissionDto,
  UpdateAffiliateSettingsDto,
  UpdatePartnerCommissionDto,
  UpdatePartnerStatusDto,
  UpdatePayoutStatusDto,
} from '../dto/admin-affiliate.dto.js';

@ApiTags('Admin Affiliate')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/affiliate')
export class AdminAffiliateController {
  constructor(
    private readonly settingsService: AffiliateSettingsService,
    private readonly partnersService: PartnersService,
    private readonly ledgerService: AffiliateLedgerService,
    private readonly payoutService: PartnerPayoutService,
    private readonly accrualService: CommissionAccrualService,
    private readonly partnerAuthService: PartnerAuthService,
    private readonly schedulerService: AffiliateSchedulerService,
  ) {}

  // ── Programme settings ─────────────────────────────────

  @Get('settings')
  @ApiOperation({ summary: 'Current affiliate programme rules' })
  async getSettings() {
    return this.settingsService.get();
  }

  @Patch('settings')
  @ApiOperation({
    summary:
      'Update commission rate, thresholds and schedule. Existing commissions keep the rate they were accrued at.',
  })
  async updateSettings(@Body() dto: UpdateAffiliateSettingsDto) {
    const before = await this.settingsService.get();
    const settings = await this.settingsService.update(dto);

    // The accrual cadence is baked into the BullMQ repeatable job, not read at
    // run time. Without re-registering it here the admin would see the new
    // interval in the UI while the queue kept firing on the old one until the
    // next deploy. `upsertJobScheduler` is keyed on a stable id in Redis, so
    // one instance doing this converges the schedule for every replica.
    if (settings.accrualIntervalHours !== before.accrualIntervalHours) {
      await this.schedulerService.syncSchedules();
    }

    return settings;
  }

  // ── Overview ───────────────────────────────────────────

  @Get('overview')
  @ApiOperation({ summary: 'Programme-wide totals' })
  async overview() {
    const [ledger, pending, active] = await Promise.all([
      this.ledgerService.getAdminOverview(),
      this.partnersService.countByStatus(PartnerStatus.PENDING),
      this.partnersService.countByStatus(PartnerStatus.ACTIVE),
    ]);

    return {
      ...ledger,
      pendingApplications: pending,
      activePartners: active,
    };
  }

  // ── Partners ───────────────────────────────────────────

  @Get('partners')
  @ApiOperation({ summary: 'List partners (paginated, searchable, sortable)' })
  async listPartners(@Query() query: PartnerListQueryDto) {
    const [items, total] = await this.partnersService.findAllForAdmin(
      query.page,
      query.limit,
      { search: query.search, status: query.status },
      query.sortBy,
      query.sortOrder,
      query.shouldCount,
    );

    return paginatedResponse(
      items.map((p) => this.partnerAuthService.sanitize(p)),
      total,
      query.page,
      query.limit,
    );
  }

  @Get('partners/:id')
  @ApiOperation({ summary: 'Partner detail with funnel and earnings' })
  async partnerDetail(@Param('id', ParseUUIDPipe) id: string) {
    const partner = await this.partnersService.findById(id);
    if (!partner) throw new NotFoundException('Partner not found');

    const [stats, eligibility] = await Promise.all([
      this.partnersService.getStats(id),
      this.payoutService.getEligibility(id),
    ]);

    return {
      partner: this.partnerAuthService.sanitize(partner),
      referralLink: this.partnerAuthService.getReferralLink(
        partner.referralCode,
      ),
      stats,
      payout: eligibility,
    };
  }

  @Patch('partners/:id/status')
  @ApiOperation({ summary: 'Approve, suspend or reject a partner' })
  async setPartnerStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerStatusDto,
  ) {
    const partner = await this.partnersService.setStatus(
      id,
      dto.status,
      dto.adminNotes,
    );
    return this.partnerAuthService.sanitize(partner);
  }

  @Patch('partners/:id/commission')
  @ApiOperation({
    summary:
      'Set or clear a per-partner commission override. Send nulls to revert to the global rate.',
  })
  async setPartnerCommission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerCommissionDto,
  ) {
    const partner = await this.partnersService.setCommissionOverride(id, {
      commissionType: dto.commissionType ?? null,
      commissionRate: dto.commissionRate ?? null,
    });
    return this.partnerAuthService.sanitize(partner);
  }

  // ── Payouts ────────────────────────────────────────────

  @Get('payouts')
  @ApiOperation({ summary: 'Payout queue' })
  async listPayouts(@Query() query: PayoutListQueryDto) {
    const [items, total] = await this.ledgerService.listPayoutsForAdmin(
      query.page,
      query.limit,
      query.status,
      query.shouldCount,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Patch('payouts/:id')
  @ApiOperation({ summary: 'Record the outcome of a payout' })
  async updatePayout(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: UpdatePayoutStatusDto,
  ) {
    // Marking a payout FAILED also returns its commissions to the unpaid pool.
    // That happens inside updatePayoutStatus' transaction rather than as a
    // second call here: committing the status without the release would strand
    // the money as `paid` against a payout that never went out, and
    // reconciliation cannot detect it because the ledger is what it trusts.
    return this.ledgerService.updatePayoutStatus(id, { ...dto, adminId });
  }

  // ── Remediation ────────────────────────────────────────
  // The accrual query already skips blocked referrals and reconciliation
  // already ignores reversed commissions; these are the endpoints that write
  // those states. Without them a fraudulent or refunded referral keeps earning
  // and gets paid at the end of the month.

  @Patch('commissions/:id/reverse')
  @ApiOperation({
    summary:
      'Claw back an accrued commission. Rejects rows already included in a settled payout.',
  })
  async reverseCommission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseCommissionDto,
  ) {
    const reversed = await this.ledgerService.reverseCommission(id, dto.reason);
    return { reversed };
  }

  @Patch('referrals/:id/block')
  @ApiOperation({
    summary:
      'Exclude a referral (fraud, self-referral, chargeback) and reverse its unpaid commissions.',
  })
  async blockReferral(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockReferralDto,
  ) {
    return this.ledgerService.blockReferral(id, dto.reason);
  }

  // ── Manual job triggers ────────────────────────────────

  @Post('jobs/accrual')
  @ApiOperation({
    summary: 'Run commission accrual now. Idempotent — safe to re-run.',
  })
  async runAccrual() {
    return this.accrualService.runAccrual();
  }

  @Post('jobs/payouts')
  @ApiOperation({
    summary:
      'Run the payout cycle now, ignoring the day-of-month gate. One payout per partner per month is still enforced.',
  })
  async runPayouts() {
    return this.payoutService.runPayouts({ force: true });
  }

  @Post('jobs/reconcile')
  @ApiOperation({
    summary:
      'Rebuild cached partner totals from the commission ledger. Returns partners whose cache had drifted.',
  })
  async reconcile() {
    const drifted = await this.accrualService.reconcilePartnerTotals();
    return { driftedPartners: drifted.length, details: drifted };
  }
}
