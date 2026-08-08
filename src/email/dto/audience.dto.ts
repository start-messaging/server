import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { KycStatus } from '../../users/enums/kyc-status.enum.js';
import { EmailAudienceType } from '../entities/email-campaign.entity.js';

/**
 * A filter over the customer table.
 *
 * Every field is optional and they combine with AND. An entirely empty filter
 * is legal and means "every customer" — the guard against sending that by
 * accident is the confirmation step in the panel and `MAX_AUDIENCE_SIZE`, not
 * a validation error here, because "all customers" is a genuine audience.
 */
export class AudienceFilterDto {
  @ApiPropertyOptional({ enum: ['active', 'suspended'] })
  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';

  @ApiPropertyOptional({ enum: KycStatus, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(KycStatus, { each: true })
  @ArrayMaxSize(10)
  kycStatus?: KycStatus[];

  @ApiPropertyOptional({ description: 'Customers carrying any of these tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  tagIds?: string[];

  @ApiPropertyOptional({ description: 'ISO-3166 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasCompletedOnboarding?: boolean;

  @ApiPropertyOptional({ description: 'Signed up on or after (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  createdAfter?: string;

  @ApiPropertyOptional({ description: 'Signed up on or before (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  createdBefore?: string;

  @ApiPropertyOptional({
    description: 'Only accounts that have never completed a top-up',
  })
  @IsOptional()
  @IsBoolean()
  neverToppedUp?: boolean;
}

/** One address the admin supplied by hand. */
export class ManualRecipientDto {
  @IsString()
  @Length(3, 320)
  email: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  companyName?: string;
}

/**
 * Who a campaign goes to.
 *
 * The two sources are not exclusive by accident — a campaign routinely wants
 * "everyone tagged 'trial expired', plus these six people finance mentioned",
 * and forcing that into two separate campaigns would split the analytics for
 * one piece of outreach.
 */
export class AudienceDto {
  @ApiPropertyOptional({ enum: EmailAudienceType })
  @IsOptional()
  @IsEnum(EmailAudienceType)
  type?: EmailAudienceType;

  @ApiPropertyOptional({ type: AudienceFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceFilterDto)
  filter?: AudienceFilterDto;

  @ApiPropertyOptional({ type: [ManualRecipientDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualRecipientDto)
  @ArrayMaxSize(5_000)
  manual?: ManualRecipientDto[];

  /**
   * Free-text paste, parsed server-side.
   *
   * Kept alongside the structured list so the panel can offer a textarea
   * without having to implement address parsing in the browser as well.
   */
  @ApiPropertyOptional({ description: 'Raw pasted addresses, any common format' })
  @IsOptional()
  @IsString()
  @Length(0, 500_000)
  manualRaw?: string;
}
