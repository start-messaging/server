import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChannelsService } from './channels.service.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';

@ApiTags('Channels & Templates')
@ApiBearerAuth()
@SkipOnboarding()
@Controller()
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get('channels')
  @ApiOperation({ summary: 'List active channels' })
  findChannels() {
    return this.channelsService.findActiveChannels();
  }

  @Get('channels/:id/templates')
  @ApiOperation({ summary: 'List templates for a channel' })
  findTemplatesByChannel(@Param('id', ParseUUIDPipe) id: string) {
    return this.channelsService.findTemplatesByChannel(id);
  }

  @Get('templates')
  @ApiOperation({ summary: 'List all active OTP templates' })
  findAllTemplates() {
    return this.channelsService.findAllActiveTemplates();
  }
}
