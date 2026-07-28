import {
  IsEnum,
  IsOptional,
  IsDateString,
  IsIn,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { WalletTransactionType } from '../entities/wallet-transaction.entity.js';

/** Sort keys accepted by the transaction lists. */
export const TRANSACTION_SORT_FIELDS = [
  'created_at',
  'amount',
  'type',
  'balance_after',
] as const;

export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export class TransactionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filter transactions from this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter transactions until this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    enum: WalletTransactionType,
    description: 'Filter by transaction type',
  })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @ApiPropertyOptional({ description: 'Search the transaction description' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: TRANSACTION_SORT_FIELDS, default: 'created_at' })
  @IsOptional()
  @IsIn([...TRANSACTION_SORT_FIELDS])
  declare sortBy?: TransactionSortField;
}
