import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../users/enums/user-role.enum.js';

export class GoogleAuthDto {
  @ApiProperty({ description: 'Google ID token from frontend' })
  @IsString()
  idToken: string;

  @ApiPropertyOptional({
    enum: [UserRole.CUSTOMER],
    default: UserRole.CUSTOMER,
  })
  @IsOptional()
  @IsEnum([UserRole.CUSTOMER])
  role?: UserRole.CUSTOMER;

  @ApiPropertyOptional({
    description: 'ISO 3166-1 alpha-2 country code',
    example: 'IN',
  })
  @IsOptional()
  @IsString()
  country?: string;
}
