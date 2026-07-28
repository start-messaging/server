import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TransactionQueryDto } from '../../wallet/dto/transaction-query.dto.js';

/**
 * Admin view of a customer's wallet history. Same filters the customer gets,
 * plus the reference type so support can isolate top-ups from OTP spend.
 */
export class AdminTransactionQueryDto extends TransactionQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter by what caused the transaction, e.g. payment, otp_usage',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  referenceType?: string;
}
