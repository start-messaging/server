import {
  IsOptional,
  IsString,
  IsArray,
  IsIP,
  ArrayMaxSize,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateApiKeyDto {
  @ApiPropertyOptional({ example: 'Production Key' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({
    example: ['203.0.113.5'],
    description: 'List of allowed IPs. Omit or null to allow all IPs.',
  })
  @IsOptional()
  @IsArray()
  @IsIP(undefined, { each: true })
  @ArrayMaxSize(20)
  allowedIps?: string[] | null;
}
