import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  BOOLEAN_QUERY_VALUES,
  PaginationQueryDto,
} from '../../common/dto/pagination-query.dto.js';
import {
  LeadEnrichmentStatus,
  LeadLiveness,
  LeadStatus,
} from '../enums/lead.enum.js';

export const LEAD_LIST_SORT_FIELDS = [
  'createdAt',
  'registeredOn',
  'score',
  'qualificationScore',
  'teamRating',
  'domain',
] as const;

export type LeadListSortField = (typeof LEAD_LIST_SORT_FIELDS)[number];

export class LeadFilterQueryDto extends OmitType(PaginationQueryDto, [
  'sortBy',
  'sortOrder',
] as const) {
  @ApiPropertyOptional({ description: 'Matches domain and siteTitle' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: LeadStatus })
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadEnrichmentStatus })
  @IsOptional()
  @IsEnum(LeadEnrichmentStatus)
  enrichmentStatus?: LeadEnrichmentStatus;

  @ApiPropertyOptional({
    enum: LeadLiveness,
    description: 'Tier-0 tag: live / inactive / unknown (never probed)',
  })
  @IsOptional()
  @IsEnum(LeadLiveness)
  liveness?: LeadLiveness;

  // Booleans-as-strings, like withCount on the base DTO: the global pipe's
  // implicit conversion turns 'false' into true on a boolean-typed field, so
  // a boolean here would lie. Parsed in the service.
  @ApiPropertyOptional({
    enum: BOOLEAN_QUERY_VALUES,
    description: 'true = at least one email/phone/whatsapp, false = none',
  })
  @IsOptional()
  @IsIn(BOOLEAN_QUERY_VALUES)
  hasContact?: string;

  @ApiPropertyOptional({
    enum: BOOLEAN_QUERY_VALUES,
    description: 'true = isIndian IS TRUE, false = everything else',
  })
  @IsOptional()
  @IsIn(BOOLEAN_QUERY_VALUES)
  india?: string;

  @ApiPropertyOptional({ enum: LEAD_LIST_SORT_FIELDS })
  @IsOptional()
  @IsIn([...LEAD_LIST_SORT_FIELDS])
  sortBy?: LeadListSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc', 'ASC', 'DESC'] })
  @IsOptional()
  @IsIn(['asc', 'desc', 'ASC', 'DESC'])
  sortOrder?: string;
}
