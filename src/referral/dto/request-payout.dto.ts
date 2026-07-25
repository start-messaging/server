import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class RequestPayoutDto {
  @ApiPropertyOptional({
    description: 'Optionally update the payout destination for this request',
    example: { upiId: 'partner@upi' },
  })
  @IsOptional()
  @IsObject()
  payoutDetails?: Record<string, any>;
}
