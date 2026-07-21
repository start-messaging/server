import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class JoinProgramDto {
  @ApiPropertyOptional({
    description: 'Payout destination, e.g. { "upiId": "name@bank" }',
    example: { upiId: 'partner@upi' },
  })
  @IsOptional()
  @IsObject()
  payoutDetails?: Record<string, any>;
}
