import {
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class OtpVariablesDto {
  @ApiProperty({ example: '123456', description: '4-6 digit OTP code to send' })
  @IsString()
  @Matches(/^\d{4,6}$/, {
    message: 'OTP must be a 4-6 digit numeric string',
  })
  otp: string;

  @ApiPropertyOptional({ example: 'YourApp' })
  @IsOptional()
  @IsString()
  appName?: string;

  @ApiPropertyOptional({ example: '5' })
  @IsOptional()
  @IsString()
  expiry?: string;

  [key: string]: string | undefined;
}

export class SendOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message: 'Phone number must be in E.164 format',
  })
  phoneNumber: string;

  @ApiPropertyOptional({
    description: 'OTP template ID to use for the message',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiProperty({
    description:
      'Template variables including the OTP code. Must contain an "otp" key with a 4-6 digit string.',
    example: { otp: '123456', appName: 'YourApp', expiry: '5' },
  })
  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => OtpVariablesDto)
  variables: OtpVariablesDto;
}
