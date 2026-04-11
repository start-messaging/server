import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { KycStatus } from '../../users/enums/kyc-status.enum.js';

export const USER_LIST_SORT_FIELDS = [
  'created_at',
  'name',
  'email',
  'last_called',
  'last_login',
  'kyc_status',
  'role',
] as const;

export type UserListSortField = (typeof USER_LIST_SORT_FIELDS)[number];

export class UserFilterQueryDto extends OmitType(PaginationQueryDto, [
  'sortBy',
  'sortOrder',
] as const) {
  @ApiPropertyOptional({ description: 'active | suspended' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description:
      'Matches name (first, last, full), email, mobile, business name, company, website, PAN, GSTIN',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: KycStatus })
  @IsOptional()
  @IsEnum(KycStatus)
  kycStatus?: KycStatus;

  @ApiPropertyOptional({
    enum: USER_LIST_SORT_FIELDS,
    description: 'Sort field (whitelist)',
  })
  @IsOptional()
  @IsIn([...USER_LIST_SORT_FIELDS])
  sortBy?: UserListSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
