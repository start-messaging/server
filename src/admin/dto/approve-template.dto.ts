import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class ApproveTemplateDto {
  @ApiPropertyOptional({
    description:
      'Provider identifiers to attach on approval, e.g. ' +
      '{ "2factor": "OTP1", "fast2sms": "1234567890" }',
    example: { '2factor': 'OTP1', fast2sms: '1234567890' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
