import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MessagesService } from './messages.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { MessageQueryDto } from './dto/message-query.dto.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';
import { cursorResponse } from '../common/utils/cursor.util.js';

@ApiTags('Messages')
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  @ApiOperation({
    summary:
      'List messages. Filter by date, status and API key; sort by a whitelisted field. ' +
      'Pass `cursor` for keyset pagination instead of `page`.',
  })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query() query: MessageQueryDto,
  ) {
    const filters = {
      startDate: query.startDate,
      endDate: query.endDate,
      status: query.status,
      apiKeyId: query.apiKeyId,
    };

    // Cursor mode: flat cost per page and stable under concurrent inserts,
    // which is what a client walking its whole history wants.
    if (query.cursor !== undefined) {
      // Keyset pagination seeks on (createdAt, id); that ordering is what makes
      // the cursor meaningful, so it cannot be overridden. This used to accept
      // sortBy/sortOrder and drop them silently, so a client asking for
      // `sortBy=cost&cursor=…` got newest-first rows back believing they were
      // sorted by cost.
      if (query.sortBy !== undefined || query.sortOrder !== undefined) {
        throw new BadRequestException(
          'sortBy and sortOrder cannot be combined with cursor pagination; ' +
            'cursor pages are always ordered newest first. Use page-based ' +
            'pagination to sort by another field.',
        );
      }

      const page = await this.messagesService.findByUserCursor(
        userId,
        query.limit,
        query.cursor || undefined,
        filters,
      );
      return cursorResponse(page, query.limit);
    }

    const [items, total] = await this.messagesService.findByUser(
      userId,
      query.page,
      query.limit,
      filters,
      query.sortBy,
      query.sortOrder,
      query.shouldCount,
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
