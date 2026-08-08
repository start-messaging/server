import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { EmailSuppressionReason } from '../enums/email-suppression-reason.enum.js';

export class AddSuppressionDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    enum: EmailSuppressionReason,
    default: EmailSuppressionReason.MANUAL,
  })
  @IsOptional()
  @IsEnum(EmailSuppressionReason)
  reason: EmailSuppressionReason = EmailSuppressionReason.MANUAL;

  @ApiPropertyOptional({ description: 'Why, for whoever reads this later' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

export class SuppressionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: EmailSuppressionReason })
  @IsOptional()
  @IsEnum(EmailSuppressionReason)
  reason?: EmailSuppressionReason;
}
