import { IsArray, IsIP, IsOptional, ArrayMaxSize } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateApiKeyIpsDto {
  @ApiPropertyOptional({
    example: ['203.0.113.5', '198.51.100.10'],
    description:
      'List of allowed IPs. Set to null or empty array to allow all IPs.',
  })
  @IsOptional()
  @IsArray()
  @IsIP(undefined, { each: true })
  @ArrayMaxSize(20)
  allowedIps?: string[] | null;
}
