import {
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Readable } from 'stream';
import { Roles } from '../common/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import { excludePassword } from '../common/utils/user.util.js';
import { R2UploadService } from '../common/services/r2-upload.service.js';
import { UsersService } from '../users/users.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { ChannelsService } from '../channels/channels.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { ReviewKycDto } from './dto/review-kyc.dto.js';
import { KycFilterQueryDto } from './dto/kyc-filter-query.dto.js';
import { AdminMessageQueryDto } from './dto/admin-message-query.dto.js';
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
    private readonly configService: ConfigService,
    private readonly channelsService: ChannelsService,
    private readonly walletService: WalletService,
    private readonly apiKeysService: ApiKeysService,
  ) {}

  // User management
  @Get('users')
  @ApiOperation({ summary: 'List all users (paginated)' })
  async getUsers(@Query() query: PaginationQueryDto) {
    const [items, total] = await this.usersService.findAll(
      query.page,
      query.limit,
    );
    const sanitized = items.map(excludePassword);
    return paginatedResponse(sanitized, total, query.page, query.limit);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Activate or suspend a user' })
  async updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    const user = await this.usersService.setActive(id, dto.isActive);
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
    );
    const sanitized = items.map(excludePassword);
    return paginatedResponse(sanitized, total, query.page, query.limit);
  }

  @Get('kyc/:userId')
  @ApiOperation({ summary: 'Get KYC details for a user' })
  async getKycDetail(@Param('userId') userId: string) {
    const user = await this.usersService.findById(userId);
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
    const [, totalUsers] = await this.usersService.findAll(1, 1);
    const activeUsers = await this.usersService.countActive();
    const { totalMessages, totalRevenue } =
      await this.messagesService.getAdminStats();
    const pendingKycCount = await this.usersService.countByKycStatus(
      KycStatus.PENDING,
    );

    return {
      totalUsers,
      activeUsers,
      totalMessages,
      totalRevenue,
      pendingKycCount,
    };
  }

  // SMS provider wallet
  @Get('sms-wallet')
  @ApiOperation({ summary: 'Get Fast2SMS wallet balance' })
  async getSmsWallet() {
    const apiKey = this.configService.get<string>('sms.fast2sms.apiKey');
    if (!apiKey) {
      throw new InternalServerErrorException(
        'Fast2SMS API key is not configured',
      );
    }

    const res = await fetch(
      `https://www.fast2sms.com/dev/wallet?authorization=${encodeURIComponent(apiKey)}`,
    );
    const data = await res.json();

    if (!data.return) {
      throw new InternalServerErrorException(
        'Failed to fetch SMS wallet balance',
      );
    }

    return {
      balance: data.wallet,
      smsCount: data.sms_count,
    };
  }

  // Customer detail
  @Get('users/:userId/overview')
  @ApiOperation({
    summary: 'Customer overview: wallet, message stats, API key count',
  })
  async getUserOverview(@Param('userId') userId: string) {
    const [wallet, messageStats, apiKeyCount] = await Promise.all([
      this.walletService.getWallet(userId),
      this.messagesService.getAdminUserStats(userId),
      this.apiKeysService.countByUser(userId),
    ]);

    return {
      wallet: { balance: Number(wallet.balance), currency: wallet.currency },
      messages: messageStats,
      apiKeyCount,
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
      query.startDate,
      query.endDate,
      query.status,
      query.phoneNumber,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('users/:userId/transactions')
  @ApiOperation({ summary: 'Wallet transactions for a user (all types)' })
  async getUserTransactions(
    @Param('userId') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.walletService.getTransactionsAdmin(
      userId,
      query.page,
      query.limit,
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
