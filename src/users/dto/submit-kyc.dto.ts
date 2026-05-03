import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
} from 'class-validator';

export class SubmitKycDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessName: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, {
    message: 'PAN must be in format ABCDE1234F',
  })
  pan: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, {
    message: 'GSTIN must be a valid 15-character GSTIN',
  })
  gstin?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessAddress: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsUrl(
    {},
    { message: 'Website URL must be a valid URL (e.g. https://example.com)' },
  )
  websiteUrl?: string;
}
