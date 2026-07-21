import { Controller, Get, Param } from '@nestjs/common';
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
  @ApiOperation({ summary: 'List approved system templates for a channel' })
  findTemplatesByChannel(@Param('id') id: string) {
    return this.channelsService.findSystemTemplatesByChannel(id);
  }
}
