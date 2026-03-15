import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { OtpService } from './otp.service.js';
import { SendOtpDto } from './dto/send-otp.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CurrentApiKeyId } from '../common/decorators/current-api-key-id.decorator.js';

@ApiTags('OTP')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('send')
  @Throttle({ default: { limit: 200, ttl: 10000 } }) // 200 requests per 10 seconds (averages to 20/sec)
  @ApiOperation({ summary: 'Send OTP to a phone number' })
  send(
    @CurrentUser('id') userId: string,
    @Body() dto: SendOtpDto,
    @CurrentApiKeyId() apiKeyId?: string,
  ) {
    return this.otpService.send(userId, dto, apiKeyId);
  }
}
