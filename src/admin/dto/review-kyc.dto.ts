import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

export class ReviewKycDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  @IsNotEmpty()
  action: 'approve' | 'reject';

  @ApiPropertyOptional()
  @ValidateIf((o) => o.action === 'reject')
  @IsString()
  @IsNotEmpty({ message: 'Rejection reason is required when rejecting' })
  @IsOptional()
  rejectionReason?: string;
}
