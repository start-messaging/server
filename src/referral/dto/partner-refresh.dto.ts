import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class PartnerRefreshDto {
  @ApiProperty({ description: 'The refresh token returned at login/register' })
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
