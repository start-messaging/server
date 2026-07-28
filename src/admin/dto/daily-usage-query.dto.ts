import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

export class DailyUsageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'IST calendar date to report on (YYYY-MM-DD). Defaults to today.',
    example: '2026-07-26',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  date?: string;

  @ApiPropertyOptional({
    description: 'Filter the report to matching customers',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
