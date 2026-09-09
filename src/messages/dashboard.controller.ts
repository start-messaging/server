import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MessagesService } from './messages.service.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { generateUsageGuide } from '../api-keys/usage-guide.helper.js';
import { DashboardStatsQueryDto } from './dto/dashboard-stats-query.dto.js';
import { DashboardTrendsQueryDto } from './dto/dashboard-trends-query.dto.js';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly messagesService: MessagesService,
    private readonly apiKeysService: ApiKeysService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get dashboard stats for current user' })
  async getStats(
    @CurrentUser('id') userId: string,
    @Query() query: DashboardStatsQueryDto,
  ) {
    return this.messagesService.getDashboardStats(
      userId,
      query.startDate,
      query.endDate,
    );
  }

  @Get('trends')
  @ApiOperation({ summary: 'Get message trends for graphs' })
  async getTrends(
    @CurrentUser('id') userId: string,
    @Query() query: DashboardTrendsQueryDto,
  ) {
    // The DTO owns both the default and the range check; a bare `@Query('days')`
    // let an absurd value through to a Date and then to Postgres as a 500.
    return this.messagesService.getDashboardTrends(userId, query.days);
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'List all API keys for current user' })
  async getApiKeys(@CurrentUser('id') userId: string) {
    return this.apiKeysService.findAllByUser(userId);
  }

  @Get('usage-guide')
  @ApiOperation({
    summary: 'Get API usage guide with code examples in multiple languages',
  })
  getUsageGuide() {
    return generateUsageGuide('YOUR_API_KEY');
  }
}
