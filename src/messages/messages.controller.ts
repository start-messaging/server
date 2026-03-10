import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MessagesService } from './messages.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { MessageQueryDto } from './dto/message-query.dto.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';

@ApiTags('Messages')
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  @ApiOperation({ summary: 'List messages (paginated, optional date filter)' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query() query: MessageQueryDto,
  ) {
    const [items, total] = await this.messagesService.findByUser(
      userId,
      query.page,
      query.limit,
      query.startDate,
      query.endDate,
    );
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get message by ID' })
  findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.messagesService.findById(id, userId);
  }

  @Post(':id/check-status')
  @ApiOperation({ summary: 'Check delivery status from SMS provider' })
  checkStatus(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.messagesService.checkStatus(id, userId);
  }
}
