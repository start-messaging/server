import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message: 'Phone number must be in E.164 format',
  })
  phoneNumber: string;

  @ApiProperty({ example: '123456', description: '4-8 digit OTP code to send' })
  @IsString()
  @Matches(/^\d{4,8}$/, {
    message: 'OTP must be a 4-8 digit numeric string',
  })
  otp: string;

  @ApiPropertyOptional({
    description: 'OTP template ID to use for the message',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;
}
