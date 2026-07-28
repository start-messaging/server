import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PayoutMethod } from '../entities/partner.entity.js';

export class UpdatePartnerProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;
}

/**
 * Where a payout should be sent.
 *
 * The bank fields are conditionally required on `payoutMethod` so a partner
 * cannot end up "configured" with a method but no destination — the monthly
 * run would raise a payout nobody could actually settle.
 */
export class UpdatePayoutDetailsDto {
  @ApiPropertyOptional({ enum: PayoutMethod })
  @IsOptional()
  @IsEnum(PayoutMethod)
  payoutMethod?: PayoutMethod;

  @ApiPropertyOptional()
  @ValidateIf(
    (o: UpdatePayoutDetailsDto) => o.payoutMethod === PayoutMethod.BANK,
  )
  @IsString()
  @MaxLength(150)
  bankAccountName?: string;

  @ApiPropertyOptional()
  @ValidateIf(
    (o: UpdatePayoutDetailsDto) => o.payoutMethod === PayoutMethod.BANK,
  )
  @Matches(/^\d{6,20}$/, { message: 'bankAccountNumber must be 6-20 digits' })
  bankAccountNumber?: string;

  @ApiPropertyOptional({ example: 'HDFC0001234' })
  @ValidateIf(
    (o: UpdatePayoutDetailsDto) => o.payoutMethod === PayoutMethod.BANK,
  )
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: 'bankIfsc must be a valid IFSC code',
  })
  bankIfsc?: string;

  @ApiPropertyOptional({ example: 'name@bank' })
  @ValidateIf(
    (o: UpdatePayoutDetailsDto) => o.payoutMethod === PayoutMethod.UPI,
  )
  // Hyphen sits last in the class so it is a literal, not a range.
  @Matches(/^[\w.-]{2,64}@[A-Za-z]{2,32}$/, {
    message: 'upiId must be a valid UPI address',
  })
  upiId?: string;

  @ApiPropertyOptional({ example: 'ABCDE1234F' })
  @IsOptional()
  @Matches(/^[A-Z]{5}\d{4}[A-Z]$/, { message: 'pan must be a valid PAN' })
  pan?: string;
}
