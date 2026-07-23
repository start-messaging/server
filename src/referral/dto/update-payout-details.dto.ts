import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdatePayoutDetailsDto {
  @ApiProperty({
    description: 'Payout destination, e.g. { "upiId": "name@bank" }',
    example: { upiId: 'partner@upi' },
  })
  @IsObject()
  payoutDetails: Record<string, any>;
}
