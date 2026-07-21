import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChannelsService } from './channels.service.js';
import { CreateMyTemplateDto } from './dto/create-my-template.dto.js';
import { UpdateMyTemplateDto } from './dto/update-my-template.dto.js';
import { MyTemplatesQueryDto } from './dto/my-templates-query.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';
import { paginatedResponse } from '../common/utils/pagination.util.js';

/**
 * Customer-facing OTP template management. Templates are owned by the calling
 * user; they author (draft) → submit → admin approves/rejects. Only approved
 * templates (own or system) can be used when sending.
 */
@ApiTags('Templates')
@ApiBearerAuth()
@SkipOnboarding()
@Controller('templates')
export class TemplatesController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get()
  @ApiOperation({ summary: 'List my OTP templates (paginated, filterable)' })
  async listMine(
    @CurrentUser('id') userId: string,
    @Query() query: MyTemplatesQueryDto,
  ) {
    const [items, total] = await this.channelsService.listMyTemplates(userId, {
      page: query.page,
      limit: query.limit,
      status: query.status,
      channelId: query.channelId,
      search: query.search,
    });
    return paginatedResponse(items, total, query.page, query.limit);
  }

  @Get('available')
  @ApiOperation({
    summary: 'List templates usable for sending (my approved + system)',
  })
  listAvailable(@CurrentUser('id') userId: string) {
    return this.channelsService.listAvailableTemplates(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of my templates (or a system template)' })
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.channelsService.getMyTemplate(userId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft OTP template' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateMyTemplateDto) {
    return this.channelsService.createMyTemplate(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft/rejected template (resets to draft)' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMyTemplateDto,
  ) {
    return this.channelsService.updateMyTemplate(userId, id, dto);
  }

  @Post(':id/submit')
  @ApiOperation({ summary: 'Submit a template for admin review' })
  submit(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.channelsService.submitMyTemplate(userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete one of my templates' })
  async remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.channelsService.deleteMyTemplate(userId, id);
    return { deleted: true };
  }
}
