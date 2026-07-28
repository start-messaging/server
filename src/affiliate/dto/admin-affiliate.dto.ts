import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { CommissionType } from '../entities/affiliate-settings.entity.js';
import { PartnerStatus } from '../entities/partner.entity.js';
import { PayoutStatus } from '../entities/partner-payout.entity.js';

/**
 * Global programme rules.
 *
 * Bounds are enforced here rather than left to the UI: these values multiply
 * real money, and a mistyped rate is the difference between paying 10% and
 * 1000% of revenue.
 */
export class UpdateAffiliateSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ enum: CommissionType })
  @IsOptional()
  @IsEnum(CommissionType)
  defaultCommissionType?: CommissionType;

  @ApiPropertyOptional({
    description:
      'Percent of OTP spend (0-100) when type is percent, else rupees per delivered OTP.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  // Capped at 100: as a percentage anything above it pays out more than the
  // OTP earned, and as a flat rate ₹100 per OTP is far beyond any plausible
  // setting — either way it is a typo, not an intent.
  @Max(100)
  defaultCommissionRate?: number;

  @ApiPropertyOptional({ description: 'Referrals that must have paid.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  minPaidReferrals?: number;

  @ApiPropertyOptional({ description: 'Minimum balance before a payout.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  minPayoutAmount?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 28 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // 28, not 31: a payout scheduled for the 30th would silently never fire in
  // February.
  @Max(28)
  payoutDayOfMonth?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  cookieDurationDays?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 168 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  accrualIntervalHours?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 8760 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8760)
  accrualLookbackHours?: number;
}

export class UpdatePartnerStatusDto {
  @ApiProperty({ enum: PartnerStatus })
  @IsEnum(PartnerStatus)
  status: PartnerStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}

/** Per-partner rate override. Send both nulls to revert to the global rate. */
export class UpdatePartnerCommissionDto {
  @ApiPropertyOptional({ enum: CommissionType, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(CommissionType)
  commissionType?: CommissionType | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  commissionRate?: number | null;
}

export class UpdatePayoutStatusDto {
  @ApiProperty({ enum: PayoutStatus })
  @IsEnum(PayoutStatus)
  status: PayoutStatus;

  @ApiPropertyOptional({
    description: 'Bank/UPI reference for a settled payout',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentReference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  failureReason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}

export class TrackReferralDto {
  @ApiProperty({ description: 'Referral code from the ?ref= parameter' })
  @IsString()
  @MaxLength(32)
  code: string;

  @ApiPropertyOptional({ description: 'Path the visitor landed on' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  landingPath?: string;
}
