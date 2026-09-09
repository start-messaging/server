import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../users/enums/user-role.enum.js';

/**
 * Trims and upper-cases a country code, leaving anything else untouched.
 *
 * Deliberately the same shape as the helper in register.dto.ts: the two
 * signup doors have to agree on what "IN" means, so change them together.
 */
const NormaliseCountry = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );

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

  /**
   * Bounded for the same reason RegisterDto is: a first-time Google sign-up
   * inserts the row itself, and users.country is character varying(2)
   * (InitialSchema), so `country: "IND"` reached Postgres, raised 22001 and
   * came back through the filter as a 500 on an unauthenticated endpoint.
   *
   * This route only looked safe because a deploy without GOOGLE_CLIENT_ID
   * refuses every call with a 401 before the insert — configure Google and the
   * 500 is back. Two letters, not a check against the ISO 3166-1 register, for
   * the reason register.dto.ts gives: a stale list refuses newly assigned
   * codes, and two letters is exactly what the column can hold.
   */
  @ApiPropertyOptional({
    description: 'ISO 3166-1 alpha-2 country code',
    example: 'IN',
  })
  @IsOptional()
  @NormaliseCountry()
  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be a two-letter country code',
  })
  country?: string;
}
