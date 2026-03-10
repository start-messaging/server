import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { OtpService } from './otp.service.js';
import { SendOtpDto } from './dto/send-otp.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@ApiTags('OTP')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('send')
  @ApiOperation({ summary: 'Send OTP to a phone number' })
  send(@CurrentUser('id') userId: string, @Body() dto: SendOtpDto) {
    return this.otpService.send(userId, dto);
  }
}
