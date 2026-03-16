import { Controller, Post, Get, Body, Query, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@ApiTags('Webhooks')
@Controller('webhooks/2factor')
export class TwoFactorWebhookController {
  private readonly logger = new Logger(TwoFactorWebhookController.name);

  constructor(
    @InjectQueue('sms-webhook') private readonly webhookQueue: Queue,
  ) {}

  @Post()
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle 2Factor.in SMS Delivery Report (POST)' })
  async handleCallbackPost(@Body() body: any) {
    return this.processPayload(body);
  }

  @Get()
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle 2Factor.in SMS Delivery Report (GET)' })
  async handleCallbackGet(@Query() query: any) {
    return this.processPayload(query);
  }

  private async processPayload(payload: any) {
    // Normalize fields: 2Factor uses 'Status' in GET and 'SmsStatus' in POST sometimes
    const normalized = { ...payload };
    if (normalized.Status && !normalized.SmsStatus) {
      normalized.SmsStatus = normalized.Status;
    }

    this.logger.log(`Received 2Factor webhook: ${JSON.stringify(normalized)}`);

    await this.webhookQueue.add(
      'two-factor-update',
      normalized,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
      },
    );

    return { received: true };
  }
}
