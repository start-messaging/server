import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';

@ApiTags('Wallet')
@ApiBearerAuth()
@SkipOnboarding()
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Get wallet balance' })
  getBalance(@CurrentUser('id') userId: string) {
    return this.walletService.getWallet(userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get wallet transaction history' })
  async getTransactions(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const [items, total] = await this.walletService.getTransactions(
      userId,
      query.page,
      query.limit,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }
}
