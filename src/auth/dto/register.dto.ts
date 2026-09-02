import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../users/enums/user-role.enum.js';

/**
 * Hands the validator the value the client actually sent, when that value is
 * an object.
 *
 * The global pipe runs with `enableImplicitConversion` (main.ts), and
 * class-transformer reaches its `targetType === String` branch before it ever
 * looks at the object, so `{"length":12}` arrives as the literal string
 * "[object Object]" — fifteen characters, which sails past @IsString and
 * @MinLength(8). Accounts registered that way all shared one guessable
 * password. Arrays never had the problem: `Array.isArray` is tested first, so
 * an array stays an array and @IsString rejects it.
 *
 * Only objects are handed back raw. A number still coerces to a string,
 * because register and login coerce identically — switch that off and everyone
 * who signed up with a numeric password is locked out of the account they
 * already have.
 *
 * Belongs anywhere a secret is read off the body: LoginDto has the same hole.
 */
export const RejectObjectCoercion = () =>
  Transform(
    ({
      value,
      obj,
      key,
    }: {
      value: unknown;
      obj: Record<string, unknown>;
      key: string;
    }) => {
      const raw = obj?.[key];
      return raw !== null && typeof raw === 'object' ? raw : value;
    },
  );

/** Trims and upper-cases a country code, leaving anything else untouched. */
const NormaliseCountry = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );

export class RegisterDto {
  @ApiProperty({ example: 'dev@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'securePassword123' })
  @RejectObjectCoercion()
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  lastName: string;

  @ApiPropertyOptional({
    enum: [UserRole.CUSTOMER],
    default: UserRole.CUSTOMER,
  })
  @IsOptional()
  @IsEnum([UserRole.CUSTOMER])
  role?: UserRole.CUSTOMER;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mobileNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  websiteUrl?: string;

  /**
   * users.country is character varying(2) (InitialSchema), so an unbounded
   * string reached Postgres, raised 22001 and left the filter answering 500 on
   * an unauthenticated endpoint — `country: "IND"` was enough to do it.
   *
   * Bounded to two letters rather than checked against the full ISO 3166-1
   * alpha-2 register on purpose: a stale list would start refusing newly
   * assigned codes, and clients that send the everyday-but-wrong "UK" instead
   * of "GB" would begin failing signup outright. Two letters is exactly what
   * the column can hold, which is the invariant that was actually broken.
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
