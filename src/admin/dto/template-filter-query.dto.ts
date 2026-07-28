import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { TemplateStatus } from '../../channels/enums/template-status.enum.js';

/** Sort keys accepted by the admin template list. */
export const TEMPLATE_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'name',
  'status',
] as const;

export type TemplateSortField = (typeof TEMPLATE_SORT_FIELDS)[number];

export class TemplateFilterQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @ApiPropertyOptional({ enum: TemplateStatus })
  @IsOptional()
  @IsEnum(TemplateStatus)
  status?: TemplateStatus;

  @ApiPropertyOptional({ description: 'Search by template name or body' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  // Constrained to a whitelist: this value is resolved to a column expression
  // before it reaches ORDER BY, so an unknown key is a 400 rather than a 500.
  @ApiPropertyOptional({ enum: TEMPLATE_SORT_FIELDS, default: 'created_at' })
  @IsOptional()
  @IsIn([...TEMPLATE_SORT_FIELDS])
  declare sortBy?: TemplateSortField;
}
