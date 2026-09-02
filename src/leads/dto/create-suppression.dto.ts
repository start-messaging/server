import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { SuppressionReason } from '../enums/lead.enum.js';

export class CreateSuppressionDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ enum: SuppressionReason, default: 'manual' })
  @IsOptional()
  @IsEnum(SuppressionReason)
  reason?: SuppressionReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
