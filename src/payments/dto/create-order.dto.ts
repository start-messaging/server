import { IsNumber, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The upper bound exists to keep the order inside what `payments` can store.
 *
 * Every money column on that table is numeric(12,4), so anything that rounds to
 * 10^8 or more is a `numeric field overflow` from Postgres — not an
 * HttpException, so it surfaced as a 500. And createOrder() raises the Razorpay
 * order *before* it saves the row, which made the failure worse than a bad
 * request: the customer got a 500 while a live order sat at the gateway with
 * nothing in our database pointing at it.
 *
 * ₹10,00,000 is two orders of magnitude below the column's ceiling, so no
 * configured convenience-fee rate can gross a permitted amount up over it, and
 * it is far above any real prepaid SMS top-up. Raise it if the business needs
 * to — just keep the headroom.
 */
const MAX_TOPUP_INR = 1_000_000;

export class CreateOrderDto {
  @ApiProperty({ example: 1000, description: 'Amount in major currency unit' })
  @IsNumber()
  @Min(process.env.NODE_ENV === 'development' ? 10 : 1000)
  @Max(MAX_TOPUP_INR)
  amount: number;
}
