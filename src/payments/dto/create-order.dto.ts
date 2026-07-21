import { IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Minimum top-up in the major unit, converted to micros.
const MIN_TOPUP_UNITS = process.env.NODE_ENV === 'development' ? 10 : 1000;
const MIN_TOPUP_MICROS = MIN_TOPUP_UNITS * 1_000_000;

export class CreateOrderDto {
  @ApiProperty({
    example: 1_000_000_000,
    description:
      'Base top-up amount in integer micros (1 unit = 1,000,000 micros). ' +
      'This is the amount credited to the wallet; any convenience fee + GST ' +
      'is added on top by the server.',
  })
  @IsInt()
  @Min(MIN_TOPUP_MICROS)
  amountMicros: number;
}
