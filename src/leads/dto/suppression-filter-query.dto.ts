import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

export class SuppressionFilterQueryDto extends OmitType(PaginationQueryDto, [
  'sortBy',
  'sortOrder',
] as const) {
  @ApiPropertyOptional({ description: 'Email substring' })
  @IsOptional()
  @IsString()
  search?: string;
}
