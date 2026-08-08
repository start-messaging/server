import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * A manual wallet credit made by an admin.
 *
 * Deliberately keyed on email rather than user id: this is used while looking
 * at a support ticket, where the email is what is to hand and a mistyped uuid
 * would credit a stranger silently.
 */
export class AdminTopupDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 500, description: 'Amount in INR' })
  @IsNumber({ maxDecimalPlaces: 4 })
  // A floor above zero rather than at it: a zero-value credit writes a
  // transaction that means nothing and only confuses the ledger later.
  @Min(0.01)
  // A ceiling because this is a hand-typed field with no second approval. A
  // slipped decimal on a support top-up should bounce, not clear.
  @Max(100000)
  amount: number;

  @ApiProperty({
    example: 'Goodwill credit — failed sends on 2026-08-07',
    description:
      'Shown to the customer in their transaction history. Say why, not just what.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  description: string;

  /**
   * Optional free-text note for the admin's own records. Never shown to the
   * customer; stored alongside the transaction reference.
   */
  @ApiPropertyOptional({ example: 'Approved by Vicky, ticket #412' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  internalNote?: string;
}
