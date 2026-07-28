import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { PartnerStatus } from '../entities/partner.entity.js';
import { ReferralStatus } from '../entities/referral.entity.js';
import { CommissionStatus } from '../entities/partner-commission.entity.js';
import { PayoutStatus } from '../entities/partner-payout.entity.js';

export const PARTNER_SORT_FIELDS = [
  'created_at',
  'name',
  'email',
  'status',
  'unpaid',
  'lifetime',
  'last_login',
] as const;

export type PartnerSortField = (typeof PARTNER_SORT_FIELDS)[number];

/** Admin list of affiliate partners. */
export class PartnerListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Name, email, company or referral code' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: PartnerStatus })
  @IsOptional()
  @IsEnum(PartnerStatus)
  status?: PartnerStatus;

  @ApiPropertyOptional({ enum: PARTNER_SORT_FIELDS, default: 'created_at' })
  @IsOptional()
  @IsIn([...PARTNER_SORT_FIELDS])
  declare sortBy?: PartnerSortField;
}

/** A partner's own referral list. */
export class ReferralListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReferralStatus })
  @IsOptional()
  @IsEnum(ReferralStatus)
  status?: ReferralStatus;
}

/** A partner's own commission ledger. */
export class CommissionListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CommissionStatus })
  @IsOptional()
  @IsEnum(CommissionStatus)
  status?: CommissionStatus;
}

/** Payout history, for both the partner and the admin queue. */
export class PayoutListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PayoutStatus })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;
}
