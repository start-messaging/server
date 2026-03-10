import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class SubmitKycDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessName: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  pan: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gstin?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessAddress: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @IsUrl()
  websiteUrl: string;
}
