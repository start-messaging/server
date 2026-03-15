import { IsDateString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

export class MessageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filter messages from this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter messages until this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by API Key ID' })
  @IsOptional()
  apiKeyId?: string;
}
