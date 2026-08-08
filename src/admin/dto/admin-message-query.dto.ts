import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { MessageStatus } from '../../messages/entities/message.entity.js';
import { MESSAGE_SORT_FIELDS } from '../../messages/dto/message-query.dto.js';
import type { MessageSortField } from '../../messages/dto/message-query.dto.js';

export class AdminMessageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter from date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Filter to date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: MessageStatus })
  @IsOptional()
  @IsEnum(MessageStatus)
  status?: MessageStatus;

  @ApiPropertyOptional({ description: 'Partial phone number match' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by API key ID' })
  @IsOptional()
  @IsUUID()
  apiKeyId?: string;

  @ApiPropertyOptional({ description: 'Filter by SMS provider' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  provider?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filter by OTP template',
  })
  @IsOptional()
  @IsUUID()
  otpTemplateId?: string;

  @ApiPropertyOptional({ enum: MESSAGE_SORT_FIELDS, default: 'created_at' })
  @IsOptional()
  @IsIn([...MESSAGE_SORT_FIELDS])
  declare sortBy?: MessageSortField;
}
