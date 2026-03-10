import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { KycStatus } from '../../users/enums/kyc-status.enum.js';

export class KycFilterQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KycStatus })
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus;
}
