import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { UsersService } from '../users/users.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import { UserRole } from '../users/enums/user-role.enum.js';
import type { User } from '../users/entities/user.entity.js';
import type { CookieOptions } from 'express';
import { REFRESH_TOKEN_MAX_AGE_MS } from '../common/constants/app.constants.js';
import { AttributionService } from '../affiliate/services/attribution.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = '23505';

/** The constraint that carries "one account per email address". */
const EMAIL_UNIQUE_CONSTRAINT = 'UQ_users_email';

/**
 * True only when Postgres refused an insert because that email is taken.
 *
 * The constraint name is part of the test deliberately: UQ_users_googleId
 * raises the same SQLSTATE, and answering "Email already registered" to a
 * collision on a different column would send the caller looking in the wrong
 * place. Anything else is rethrown and stays a 500, which is honest.
 *
 * Read off `driverError` (the pg error) with the copy TypeORM assigns onto
 * QueryFailedError itself as the fallback, so this keeps working whichever of
 * the two a future TypeORM keeps.
 */
function isEmailAlreadyTaken(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate =
    (error as { driverError?: unknown }).driverError ?? (error as unknown);
  if (!candidate || typeof candidate !== 'object') return false;
  const { code, constraint } = candidate as {
    code?: string;
    constraint?: string;
  };
  return code === UNIQUE_VIOLATION && constraint === EMAIL_UNIQUE_CONSTRAINT;
}

/**
 * What every login/register/refresh call answers with.
 *
 * `isNewUser` is present (and true) only when the call CREATED the account.
 * The dashboard fires posthog.alias on first-ever sign-in to weld the
 * pre-signup lead person to the new user person, and a Google sign-in that
 * creates an account is otherwise indistinguishable from a login on the
 * client — this flag is the only place the distinction exists.
 */
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  isNewUser?: boolean;
  user: Pick<
    User,
    | 'id'
    | 'email'
    | 'firstName'
    | 'lastName'
    | 'role'
    | 'mobileNumber'
    | 'companyName'
    | 'websiteUrl'
    | 'hasCompletedOnboarding'
    | 'isActive'
    | 'country'
    | 'kycStatus'
    | 'mobileVerified'
  >;
}

/** Referral context carried on a signup request, read from the cookie. */
export interface SignupAttribution {
  referralCode: string | null;
  ipAddress?: string;
  userAgent?: string;
  landingPath?: string;
}

/** What `googleAuth` actually reads off a verified Google id token. */
interface GoogleIdentity {
  sub: string;
  email?: string;
  /**
   * Google asserts addresses it has not confirmed, and this claim is how it
   * says so. It is not optional to read — see the check in googleAuth.
   */
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client | null;
  private readonly bcryptRounds: number;
  private readonly mockGoogleVerify: boolean;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly walletService: WalletService,
    private readonly attributionService: AttributionService,
  ) {
    const googleClientId = this.configService.get<string>('google.clientId');
    this.googleClient = googleClientId
      ? new OAuth2Client(googleClientId)
      : null;
    this.bcryptRounds =
      this.configService.get<number>('auth.bcryptRounds') ?? 10;
    // Double lock, same posture as the console SMS provider but stricter:
    // live verification needs Google's public keys and a real client id, so
    // the signup/link paths were untestable end-to-end — the mock lets the
    // e2e suite present `mock:<base64url JSON>` tokens instead. It must ALSO
    // see NODE_ENV === 'test' because accepting unsigned identity assertions
    // anywhere near production would be an account-takeover primitive: any
    // email named in the payload becomes a session for that account.
    this.mockGoogleVerify =
      this.configService.get<boolean>('google.mockVerify') === true &&
      this.configService.get<string>('NODE_ENV') === 'test';
  }

  /**
   * The mock verifier behind GOOGLE_MOCK_VERIFY (see the constructor).
   *
   * Only `mock:<base64url-encoded JSON {sub, email, ...}>` is accepted; every
   * other shape — including a REAL Google id token — is refused with the very
   * same error a bad token gets from live verification, so no test can pass
   * against the mock while quietly bypassing what production would check.
   */
  private decodeMockGoogleToken(idToken: string): GoogleIdentity {
    const refusal = () => new UnauthorizedException('Invalid Google ID token');
    if (!idToken.startsWith('mock:')) throw refusal();
    try {
      const parsed = JSON.parse(
        Buffer.from(idToken.slice('mock:'.length), 'base64url').toString(
          'utf8',
        ),
      ) as GoogleIdentity;
      if (
        !parsed ||
        typeof parsed.sub !== 'string' ||
        parsed.sub.length === 0
      ) {
        throw new Error('mock google payload has no sub');
      }
      return parsed;
    } catch {
      throw refusal();
    }
  }

  /**
   * Links a brand-new account to the partner whose referral cookie it carries.
   *
   * Awaited rather than fired and forgotten so the referral exists before the
   * signup response is returned — but `attributeSignup` never throws, so a
   * problem in the affiliate programme can never stop somebody creating an
   * account.
   */
  private async attribute(
    user: User,
    attribution: SignupAttribution | undefined,
  ): Promise<void> {
    if (!attribution?.referralCode) return;

    await this.attributionService.attributeSignup(
      user.id,
      user.email,
      attribution.referralCode,
      {
        ipAddress: attribution.ipAddress,
        userAgent: attribution.userAgent,
        landingPath: attribution.landingPath,
      },
    );
  }

  async register(
    dto: RegisterDto,
    ip: string,
    attribution?: SignupAttribution,
  ) {
    // Normalised on the way in so every new row is stored one way, and the
    // duplicate check below (which is now case-insensitive) cannot be walked
    // around by changing capitalisation.
    dto.email = dto.email.trim().toLowerCase();

    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    if (dto.mobileNumber) {
      const existingMobile = await this.usersService.findByMobileNumber(
        dto.mobileNumber,
      );
      if (existingMobile) {
        throw new ConflictException('Mobile number is already registered');
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);
    const role = dto.role ?? UserRole.CUSTOMER;

    // The check above is a SELECT and this is an INSERT, with nothing holding
    // the gap — and the ~100ms bcrypt hash in between holds it wide open, so a
    // double-clicked signup button really does get both requests past the
    // check. UQ_users_email is what actually enforces one account per address;
    // the loser used to reach the filter as a raw QueryFailedError and read to
    // the user as "the site is broken" rather than "you already have an
    // account". The pre-check stays because it answers the common case without
    // an exception; this is the case it cannot see.
    let user: User;
    try {
      user = await this.usersService.create({
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role,
        mobileNumber: dto.mobileNumber ?? null,
        companyName: dto.companyName ?? null,
        websiteUrl: dto.websiteUrl ?? null,
        country: dto.country ?? null,
      });
    } catch (error) {
      if (isEmailAlreadyTaken(error)) {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }

    await this.walletService.credit(
      user.id,
      10,
      'Welcome credit',
      'registration',
      user.id,
    );

    await this.attribute(user, attribution);

    return this.buildAuthResponse(user, ip);
  }

  async login(dto: LoginDto, ip: string) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account uses Google sign-in. Please log in with Google.',
      );
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }

    return this.buildAuthResponse(user, ip);
  }

  async googleAuth(
    dto: GoogleAuthDto,
    ip: string,
    attribution?: SignupAttribution,
  ) {
    if (!this.googleClient) {
      throw new UnauthorizedException(
        'Google authentication is not configured',
      );
    }

    let payload: GoogleIdentity | undefined;
    if (this.mockGoogleVerify) {
      // Test-only (double-locked in the constructor). Everything downstream —
      // lookup, linking, creation, attribution — is the real path.
      payload = this.decodeMockGoogleToken(dto.idToken);
    } else {
      const ticket = await this.googleClient
        .verifyIdToken({
          idToken: dto.idToken,
          audience: this.configService.get<string>('google.clientId'),
        })
        .catch(() => {
          throw new UnauthorizedException('Invalid Google ID token');
        });
      payload = ticket.getPayload();
    }

    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google ID token');
    }

    // The same gate PartnerAuthService.googleAuth has carried since it was
    // written (partner-auth.service.ts), and the customer door was missing it —
    // which is the worse place to miss it, because these accounts hold the
    // wallet, the API keys and the message history.
    //
    // Step 2 below links a Google identity onto an existing account matched on
    // `email` alone. Google will assert an address it has not confirmed, so
    // without this check a genuine, correctly-audienced token carrying
    // email_verified: false for someone else's address was enough to weld an
    // attacker's googleId onto that account and be handed a full session and a
    // 7-day refresh cookie — a second permanent door that survives the victim
    // changing their password.
    if (!payload.email_verified) {
      throw new UnauthorizedException(
        'This Google account has no verified email address.',
      );
    }

    const { sub: googleId, email, given_name, family_name } = payload;

    // 1. Find by googleId
    let user = await this.usersService.findByGoogleId(googleId);
    if (user) {
      if (!user.isActive) {
        throw new UnauthorizedException('Account is suspended');
      }
      return this.buildAuthResponse(user, ip);
    }

    // 2. Find by email — link Google account
    user = await this.usersService.findByEmail(email);
    if (user) {
      if (!user.isActive) {
        throw new UnauthorizedException('Account is suspended');
      }
      await this.usersService.updateGoogleId(user.id, googleId);
      user = (await this.usersService.findById(user.id))!;
      return this.buildAuthResponse(user, ip);
    }

    // 3. New user — create with Google profile
    const role = dto.role ?? UserRole.CUSTOMER;

    user = await this.usersService.create({
      email,
      passwordHash: null,
      firstName: given_name ?? '',
      lastName: family_name ?? '',
      role,
      googleId: googleId,
      mobileNumber: null,
      companyName: null,
      websiteUrl: null,
      country: dto.country ?? null,
    });

    await this.walletService.credit(
      user.id,
      10,
      'Welcome credit',
      'registration',
      user.id,
    );

    // Only this branch attributes. The two branches above return an existing
    // account — re-attributing one would let a partner cookie an established
    // customer and take over someone else's referral.
    await this.attribute(user, attribution);

    // Set here at the return site, not inside buildAuthResponse: only this
    // branch knows the account did not exist a moment ago.
    return { ...(await this.buildAuthResponse(user, ip)), isNewUser: true };
  }

  async refreshTokens(userId: string, refreshToken: string, ip: string) {
    const user = await this.usersService.findByIdWithRefreshToken(userId);
    if (!user || !user.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(refreshToken);
    if (tokenHash !== user.refreshTokenHash) {
      // Possible token reuse attack — revoke stored token
      await this.usersService.updateRefreshTokenHash(userId, null);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!user.isActive) {
      await this.usersService.updateRefreshTokenHash(userId, null);
      throw new UnauthorizedException('Account is suspended');
    }

    return this.buildAuthResponse(user, ip);
  }

  async revokeRefreshToken(userId: string): Promise<void> {
    await this.usersService.updateRefreshTokenHash(userId, null);
  }

  getRefreshCookieOptions(): CookieOptions {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/auth',
      maxAge: REFRESH_TOKEN_MAX_AGE_MS,
    };
  }

  /**
   * Splits the `${userId}:${token}` refresh cookie.
   *
   * Takes `unknown` rather than `string` on purpose: `cookie-parser` runs
   * every cookie through `JSONCookies`, so a value the client prefixes with
   * `j:` arrives already parsed. `refresh_token=j%3A1` becomes the number 1,
   * and calling `.indexOf` on it threw — an unauthenticated 500 on a live
   * endpoint. The type the compiler sees is not the type that arrives.
   */
  parseRefreshCookie(cookieValue: unknown): {
    userId: string;
    token: string;
  } | null {
    if (typeof cookieValue !== 'string') return null;

    const separatorIndex = cookieValue.indexOf(':');
    if (separatorIndex === -1) return null;
    const userId = cookieValue.substring(0, separatorIndex);
    const token = cookieValue.substring(separatorIndex + 1);
    if (!userId || !token) return null;

    // The id half goes straight into a lookup on a uuid column, so anything
    // that is not a uuid reaches Postgres as a cast error and surfaces as a
    // 500 rather than a 401. `refresh_token=not-a-uuid:x` was enough to do it,
    // unauthenticated, on a live endpoint. A malformed cookie is a rejected
    // credential, not a server fault.
    if (!UUID_PATTERN.test(userId)) return null;

    return { userId, token };
  }

  async buildAuthResponse(user: User, ip: string): Promise<AuthResponse> {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = this.hashToken(refreshToken);

    await Promise.all([
      this.usersService.updateRefreshTokenHash(user.id, refreshTokenHash),
      this.usersService.updateLastLogin(user.id, ip),
    ]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        mobileNumber: user.mobileNumber,
        companyName: user.companyName,
        websiteUrl: user.websiteUrl,
        hasCompletedOnboarding: user.hasCompletedOnboarding,
        isActive: user.isActive,
        country: user.country,
        kycStatus: user.kycStatus,
        mobileVerified: user.mobileVerified,
      },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
