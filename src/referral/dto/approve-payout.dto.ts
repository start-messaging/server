import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApprovePayoutDto {
  @ApiPropertyOptional({ description: 'External transfer reference / UTR' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  payoutRef?: string;
}
