import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Readable } from 'stream';
import { Roles } from '../common/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { UserFilterQueryDto } from './dto/user-filter-query.dto.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import { excludePassword } from '../common/utils/user.util.js';
import { R2UploadService } from '../common/services/r2-upload.service.js';
import { UsersService } from '../users/users.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { ChannelsService } from '../channels/channels.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto.js';
import { ReviewKycDto } from './dto/review-kyc.dto.js';
import { KycFilterQueryDto } from './dto/kyc-filter-query.dto.js';
import { AdminMessageQueryDto } from './dto/admin-message-query.dto.js';
import { AdminTransactionQueryDto } from './dto/admin-transaction-query.dto.js';
import { DailyUsageQueryDto } from './dto/daily-usage-query.dto.js';
import { CreateTemplateDto } from './dto/create-template.dto.js';
import { UpdateTemplateDto } from './dto/update-template.dto.js';
import { TemplateFilterQueryDto } from './dto/template-filter-query.dto.js';
import { KycStatus } from '../users/enums/kyc-status.enum.js';

@ApiTags('Admin')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly messagesService: MessagesService,
    private readonly r2UploadService: R2UploadService,
    private readonly channelsService: ChannelsService,
    private readonly walletService: WalletService,
    private readonly apiKeysService: ApiKeysService,
    private readonly paymentsService: PaymentsService,
  ) {}

  // User management
  @Get('users')
  @ApiOperation({
    summary: 'List all users (paginated, searchable, wallet balance)',
  })
  async getUsers(@Query() query: UserFilterQueryDto) {
    const [items, total] = await this.usersService.findAll(
      query.page,
      query.limit,
      query.search,
      query.status,
      query.kycStatus,
      query.sortBy,
      query.sortOrder,
      query.shouldCount,
    );
    const balances = await this.walletService.getBalancesByUserIds(
      items.map((u) => u.id),
    );
    const sanitized = items.map((u) => ({
      ...excludePassword(u),
      walletBalance: balances.get(u.id) ?? 0,
    }));
    return paginatedResponse(sanitized, total, query.page, query.limit);
  }

  @Patch('users/:id')
  @ApiOperation({
    summary:
      'Update user (active flag, admin call tracking). Admin-only fields are never exposed on customer APIs.',
  })
  async updateUserAdmin(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    const user = await this.usersService.updateByAdmin(id, dto);
    return excludePassword(user);
  }

  // KYC management
  @Get('kyc')
  @ApiOperation({ summary: 'List KYC submissions (paginated, filterable)' })
  async getKycSubmissions(@Query() query: KycFilterQueryDto) {
    const [items, total] = await this.usersService.findByKycStatus(
      query.status,
      query.page,
      query.limit,
      query.search,
      query.sortBy,
      query.sortOrder as 'asc' | 'desc' | undefined,
      query.shouldCount,
    );
    const sanitized = items.map(excludePassword);
    return paginatedResponse(sanitized, total, query.page, query.limit);
  }

  @Get('kyc/:userId')
  @ApiOperation({ summary: 'Get KYC details for a user' })
  async getKycDetail(@Param('userId') userId: string) {
    const user = await this.usersService.findByIdForAdmin(userId);
    if (!user) return null;
    return excludePassword(user);
  }

  @Patch('kyc/:userId')
  @ApiOperation({ summary: 'Approve or reject KYC submission' })
  async reviewKyc(
    @Param('userId') userId: string,
    @CurrentUser('id') adminUserId: string,
    @Body() dto: ReviewKycDto,
  ) {
    const user = await this.usersService.reviewKyc(
      userId,
      adminUserId,
      dto.action,
      dto.rejectionReason,
    );
    return excludePassword(user);
  }

  @Get('kyc/:userId/document')
  @ApiOperation({ summary: 'Stream KYC document for a user' })
  async getKycDocument(@Param('userId') userId: string, @Res() res: Response) {
    const user = await this.usersService.findById(userId);
    if (!user?.kycDocumentPath) {
      throw new NotFoundException('No KYC document found');
    }

    const key = this.r2UploadService.extractKeyFromUrl(user.kycDocumentPath);
    if (!key) {
      throw new NotFoundException('Document path is invalid');
    }

    const { body, contentType, contentLength } =
      await this.r2UploadService.getObject(key);

    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', 'inline');

    (body as Readable).pipe(res);
  }

  // Dashboard
  @Get('dashboard')
  @ApiOperation({ summary: 'Admin dashboard stats' })
  async getDashboard() {
    const [
      totalUsers,
      activeUsers,
      userStats,
      messageStats,
      revenueStats,
      messageTrends,
      revenueTrends,
      pendingKycCount,
      razorpayStats,
    ] = await Promise.all([
      // Was `findAll(1, 1)`, which built the full filtered user query and
      // hydrated a throwaway User entity just to read the count off the tuple.
      this.usersService.countAll(),
      this.usersService.countActive(),
      this.usersService.getDashboardStats(),
      this.messagesService.getAdminDashboardStats(),
      this.walletService.getAdminAnalytics(),
      this.messagesService.getAdminTrends(7),
      this.walletService.getRevenueTrends(7),
      this.usersService.countByKycStatus(KycStatus.PENDING),
      this.paymentsService.getRazorpayCompletedStats(),
    ]);

    return {
      overview: {
        totalUsers,
        activeUsers,
        totalMessages: messageStats.total,
        totalRevenue: revenueStats.totalRevenue,
        pendingKycCount,
        razorpayPaymentsTotal: razorpayStats.totalAmount,
        razorpayPaymentsToday: razorpayStats.todayAmount,
        razorpayPaymentsCount: razorpayStats.completedCount,
      },
      growth: {
        newUsersToday: userStats.newToday,
        newUsersThisWeek: userStats.newThisWeek,
      },
      performance: {
        successRate: messageStats.successRate,
        messagesToday: messageStats.todayCount,
        revenueToday: revenueStats.todayRevenue,
        failedMessages: messageStats.failed,
      },
      trends: {
        messages: messageTrends,
        revenue: revenueTrends,
      },
    };
  }

  @Get('dashboard/daily-usage')
  @ApiOperation({
    summary: 'Daily usage per user for a specific date (paginated, searchable)',
  })
  async getDailyUsage(@Query() query: DailyUsageQueryDto) {
    const [items, total] = await this.messagesService.getAdminDailyUsage(
      query.date,
      query.page,
      query.limit,
      query.search,
      query.shouldCount,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  // Customer detail
  @Get('users/:userId/overview')
  @ApiOperation({
    summary: 'Customer overview: wallet, message stats, API key count',
  })
  async getUserOverview(@Param('userId') userId: string) {
    const [wallet, messageStats, apiKeyCount, messagesTrend] =
      await Promise.all([
        this.walletService.getWallet(userId),
        this.messagesService.getAdminUserStats(userId),
        this.apiKeysService.countByUser(userId),
        this.messagesService.getDashboardTrends(userId, 7),
      ]);

    return {
      wallet: { balance: Number(wallet.balance), currency: wallet.currency },
      messages: messageStats,
      apiKeyCount,
      messagesTrend,
    };
  }

  @Get('users/:userId/messages')
  @ApiOperation({ summary: 'Paginated message history for a user (admin)' })
  async getUserMessages(
    @Param('userId') userId: string,
    @Query() query: AdminMessageQueryDto,
  ) {
    const [items, total] = await this.messagesService.findByUserAdmin(
      userId,
      query.page,
      query.limit,
      {
        startDate: query.startDate,
        endDate: query.endDate,
        status: query.status,
        phoneNumber: query.phoneNumber,
        apiKeyId: query.apiKeyId,
        provider: query.provider,
      },
      query.sortBy,
      query.sortOrder,
      query.shouldCount,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('users/:userId/transactions')
  @ApiOperation({
    summary: 'Wallet transactions for a user (paginated, filterable, sortable)',
  })
  async getUserTransactions(
    @Param('userId') userId: string,
    @Query() query: AdminTransactionQueryDto,
  ) {
    const [items, total] = await this.walletService.getTransactionsAdmin(
      userId,
      {
        page: query.page,
        limit: query.limit,
        type: query.type,
        startDate: query.startDate,
        endDate: query.endDate,
        referenceType: query.referenceType,
        search: query.search,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        withCount: query.shouldCount,
      },
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('users/:userId/api-keys')
  @ApiOperation({ summary: 'List API keys for a user (admin, paginated)' })
  async getUserApiKeys(
    @Param('userId') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.apiKeysService.findByUserPaginated(
      userId,
      query.page,
      query.limit,
      query.shouldCount,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  // Template management
  @Get('channels')
  @ApiOperation({ summary: 'List all channels (for dropdowns)' })
  async getChannels() {
    return this.channelsService.findAllChannels();
  }

  @Get('templates')
  @ApiOperation({ summary: 'List OTP templates (paginated, filterable)' })
  async getTemplates(@Query() query: TemplateFilterQueryDto) {
    const [items, total] =
      await this.channelsService.findAllTemplatesAdmin(query);
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get template detail' })
  async getTemplateDetail(@Param('id') id: string) {
    return this.channelsService.findTemplateByIdAdmin(id);
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create a custom OTP template' })
  async createTemplate(@Body() dto: CreateTemplateDto) {
    return this.channelsService.createTemplate(dto);
  }

  @Patch('templates/:id/publish')
  @ApiOperation({ summary: 'Publish a draft template' })
  async publishTemplate(@Param('id') id: string) {
    return this.channelsService.publishTemplate(id);
  }

  @Patch('templates/:id/unpublish')
  @ApiOperation({ summary: 'Unpublish a template back to draft' })
  async unpublishTemplate(@Param('id') id: string) {
    return this.channelsService.unpublishTemplate(id);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update an OTP template' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.channelsService.updateTemplate(id, dto);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Soft-delete a custom OTP template' })
  async deleteTemplate(@Param('id') id: string) {
    await this.channelsService.deleteTemplate(id);
    return { deleted: true };
  }
}
