import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiKeysService } from './api-keys.service.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { UpdateApiKeyIpsDto } from './dto/update-api-key-ips.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@ApiTags('API Keys')
@ApiBearerAuth()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new API key (key returned once)' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateApiKeyDto) {
    return this.apiKeysService.create(userId, dto);
  }

  @Get('my-ip')
  @ApiOperation({ summary: "Get the caller's IP address" })
  getMyIp(@Req() req: Request) {
    const raw = req.ip ?? '127.0.0.1';
    const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    return { ip };
  }

  @Get('usage-guide')
  @ApiOperation({
    summary: 'Get API usage guide with code examples in multiple languages',
  })
  getUsageGuide() {
    return this.apiKeysService.getUsageGuide();
  }

  @Get()
  @ApiOperation({ summary: 'List all API keys for current user' })
  findAll(@CurrentUser('id') userId: string) {
    return this.apiKeysService.findAllByUser(userId);
  }

  @Patch(':id/ip-restrictions')
  @ApiOperation({ summary: 'Update IP restrictions for an API key' })
  updateIps(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateApiKeyIpsDto,
  ) {
    return this.apiKeysService.updateIps(id, userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an API key' })
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.apiKeysService.delete(id, userId);
  }
}
