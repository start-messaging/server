import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { KycStatus } from '../../users/enums/kyc-status.enum.js';

/** Sort keys accepted by the KYC review queue. */
export const KYC_SORT_FIELDS = [
  'submitted_at',
  'reviewed_at',
  'created_at',
  'name',
  'email',
  'business_name',
] as const;

export type KycSortField = (typeof KYC_SORT_FIELDS)[number];

export class KycFilterQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KycStatus })
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus;

  @ApiPropertyOptional({
    description:
      'Matches name, email, mobile, business name, company, PAN, GSTIN',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: KYC_SORT_FIELDS, default: 'submitted_at' })
  @IsOptional()
  @IsIn([...KYC_SORT_FIELDS])
  declare sortBy?: KycSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc', 'ASC', 'DESC'])
  declare sortOrder?: 'ASC' | 'DESC';
}
