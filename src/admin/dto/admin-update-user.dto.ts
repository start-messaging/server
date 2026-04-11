import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class AdminUpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** ISO 8601 datetime, or omit; send null to clear */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  adminLastCalledAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  adminCallNotes?: string | null;
}
