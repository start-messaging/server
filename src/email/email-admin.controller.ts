import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { EmailCampaignsService } from './services/email-campaigns.service.js';
import { EmailPreviewService } from './services/email-preview.service.js';
import { EmailSuppressionService } from './services/email-suppression.service.js';
import {
  CampaignQueryDto,
  CreateCampaignDto,
  PreviewAudienceDto,
  PreviewRenderDto,
  RecipientQueryDto,
  SendTestDto,
  UpdateCampaignDto,
} from './dto/campaign.dto.js';
import {
  AddSuppressionDto,
  SuppressionQueryDto,
} from './dto/suppression.dto.js';

/** Shape of the request user attached by the JWT strategy. */
interface AdminPrincipal {
  id?: string;
  sub?: string;
}

@ApiTags('Admin — Email')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/email')
export class EmailAdminController {
  constructor(
    private readonly campaigns: EmailCampaignsService,
    private readonly preview: EmailPreviewService,
    private readonly suppressions: EmailSuppressionService,
  ) {}

  // ── Composer support ─────────────────────────────────

  @Get('status')
  @ApiOperation({
    summary: 'Transport configuration, merge fields and sending limits',
  })
  async status() {
    const [transport, remainingToday] = await Promise.all([
      Promise.resolve(this.preview.transportStatus()),
      this.campaigns.remainingDailyAllowance(),
    ]);
    return { ...transport, remainingToday };
  }

  @Post('audience/preview')
  @ApiOperation({ summary: 'Size an audience without saving a campaign' })
  async previewAudience(@Body() dto: PreviewAudienceDto) {
    return this.campaigns.previewAudience(dto.audience);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Render a campaign as one recipient would see it' })
  async renderPreview(@Body() dto: PreviewRenderDto) {
    return this.preview.preview(dto);
  }

  // ── Campaigns ────────────────────────────────────────

  @Get('campaigns')
  @ApiOperation({ summary: 'List campaigns with their headline counters' })
  async list(@Query() query: CampaignQueryDto) {
    const [items, total] = await this.campaigns.list(query);
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Post('campaigns')
  @ApiOperation({ summary: 'Create a draft campaign' })
  async create(
    @Body() dto: CreateCampaignDto,
    @CurrentUser() admin: AdminPrincipal,
  ) {
    return this.campaigns.create(dto, admin?.id ?? admin?.sub ?? null);
  }

  @Get('campaigns/:id')
  @ApiOperation({ summary: 'Get one campaign' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.getOrFail(id);
  }

  @Patch('campaigns/:id')
  @ApiOperation({ summary: 'Update a draft campaign' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.campaigns.update(id, dto);
  }

  @Delete('campaigns/:id')
  @ApiOperation({ summary: 'Delete a campaign that is not currently sending' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.campaigns.remove(id);
    return { deleted: true };
  }

  @Post('campaigns/:id/test')
  @ApiOperation({ summary: 'Send one test copy, untracked' })
  async sendTest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendTestDto,
  ) {
    const campaign = await this.campaigns.getOrFail(id);
    await this.preview.sendTest(campaign, dto.to);
    return { sent: true, to: dto.to };
  }

  @Post('campaigns/:id/send')
  @ApiOperation({
    summary: 'Resolve the audience and start sending (or schedule)',
  })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AdminPrincipal,
  ) {
    return this.campaigns.send(id, admin?.id ?? admin?.sub ?? null);
  }

  @Post('campaigns/:id/cancel')
  @ApiOperation({ summary: 'Stop a running campaign; sent mail is not recalled' })
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.cancel(id);
  }

  // ── Analytics ────────────────────────────────────────

  @Get('campaigns/:id/stats')
  @ApiOperation({ summary: 'Funnel, rates, engagement timeline and top links' })
  async stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.getStats(id);
  }

  @Get('campaigns/:id/recipients')
  @ApiOperation({ summary: 'Per-recipient delivery and engagement' })
  async recipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RecipientQueryDto,
  ) {
    const [items, total] = await this.campaigns.listRecipients(id, query);
    return paginatedResponse(items, total, query.page, query.limit);
  }

  // ── Suppression list ─────────────────────────────────

  @Get('suppressions')
  @ApiOperation({ summary: 'Addresses that will never be mailed' })
  async listSuppressions(@Query() query: SuppressionQueryDto) {
    const [items, total] = await this.suppressions.list({
      page: query.page,
      limit: query.limit,
      search: query.search,
      reason: query.reason,
    });
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Post('suppressions')
  @ApiOperation({ summary: 'Add an address by hand' })
  async addSuppression(
    @Body() dto: AddSuppressionDto,
    @CurrentUser() admin: AdminPrincipal,
  ) {
    return this.suppressions.suppress(dto.email, dto.reason, {
      note: dto.note ?? null,
      createdBy: admin?.id ?? admin?.sub ?? null,
    });
  }

  @Delete('suppressions/:id')
  @ApiOperation({ summary: 'Lift a suppression (soft delete; history is kept)' })
  async removeSuppression(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AdminPrincipal,
  ) {
    await this.suppressions.remove(id, admin?.id ?? admin?.sub ?? null);
    return { removed: true };
  }

  /**
   * Convenience for the customer detail screen: which campaigns has this
   * person been sent, and did they engage.
   */
  @Get('users/:userId/history')
  @ApiOperation({ summary: 'Campaigns this customer has received' })
  async userHistory(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.campaigns.listRecipientsForUser(
      userId,
      query,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }
}
