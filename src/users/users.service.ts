import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { MoreThan, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { User } from './entities/user.entity.js';
import { MobileOtp } from './entities/mobile-otp.entity.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { SubmitKycDto } from './dto/submit-kyc.dto.js';
import { KycStatus } from './enums/kyc-status.enum.js';
import { EmailService } from '../common/services/email.service.js';

@Injectable()
export class UsersService {
  private readonly otpExpiryMinutes: number;
  private readonly otpMaxAttempts: number;
  private readonly otpCooldownSeconds: number;
  private readonly otpMaxPerHour: number;

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(MobileOtp)
    private readonly mobileOtpRepository: Repository<MobileOtp>,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
  ) {
    this.otpExpiryMinutes = this.config.get<number>('otp.expiryMinutes') ?? 5;
    this.otpMaxAttempts = 3;
    this.otpCooldownSeconds = 60;
    this.otpMaxPerHour = 5;
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /** Includes admin-only columns (call tracking). Use only from admin routes. */
  async findByIdForAdmin(id: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect(['user.adminLastCalledAt', 'user.adminCallNotes'])
      .where('user.id = :id', { id })
      .getOne();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findByMobileNumber(mobileNumber: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { mobileNumber } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { googleId } });
  }

  async create(data: Partial<User>): Promise<User> {
    const user = this.usersRepository.create(data);
    return this.usersRepository.save(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    if (dto.mobileNumber) {
      const existing = await this.usersRepository.findOne({
        where: { mobileNumber: dto.mobileNumber, id: Not(id) },
      });
      if (existing) {
        throw new BadRequestException(
          'Mobile number is already associated with another account.',
        );
      }
    }
    await this.usersRepository.update(id, dto);
    return this.usersRepository.findOneOrFail({ where: { id } });
  }

  async countActive(): Promise<number> {
    return this.usersRepository.count({ where: { isActive: true } });
  }

  async findAll(
    page: number,
    limit: number,
    search?: string,
    accountStatus?: string,
    kycStatus?: KycStatus,
    sortBy?: string,
    sortOrder?: 'asc' | 'desc',
  ): Promise<[User[], number]> {
    let qb = this.usersRepository
      .createQueryBuilder('user')
      .addSelect(['user.adminLastCalledAt', 'user.adminCallNotes']);

    const term = search?.trim();
    if (term) {
      const q = `%${term}%`;
      qb = qb.andWhere(
        `(
          user.firstName ILIKE :search OR user.lastName ILIKE :search OR
          CONCAT(COALESCE(user.firstName, ''), ' ', COALESCE(user.lastName, '')) ILIKE :search OR
          user.email ILIKE :search OR user.mobileNumber ILIKE :search OR
          user.businessName ILIKE :search OR user.companyName ILIKE :search OR
          user.websiteUrl ILIKE :search OR user.pan ILIKE :search OR user.gstin ILIKE :search
        )`,
        { search: q },
      );
    }

    if (accountStatus) {
      if (accountStatus === 'active') {
        qb = qb.andWhere('user.isActive = true');
      } else if (accountStatus === 'suspended') {
        qb = qb.andWhere('user.isActive = false');
      }
    }

    if (kycStatus !== undefined && kycStatus !== null) {
      qb = qb.andWhere('user.kycStatus = :kycStatus', { kycStatus });
    }

    const dir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const field = sortBy ?? 'created_at';

    switch (field) {
      case 'name':
        qb = qb.orderBy('user.firstName', dir).addOrderBy('user.lastName', dir);
        break;
      case 'email':
        qb = qb.orderBy('user.email', dir);
        break;
      case 'last_called':
        qb = qb.orderBy(
          'user.adminLastCalledAt',
          dir,
          dir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST',
        );
        break;
      case 'last_login':
        qb = qb.orderBy(
          'user.lastLoginAt',
          dir,
          dir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST',
        );
        break;
      case 'kyc_status':
        qb = qb.orderBy('user.kycStatus', dir);
        break;
      case 'role':
        qb = qb.orderBy('user.role', dir);
        break;
      case 'created_at':
      default:
        qb = qb.orderBy('user.createdAt', dir);
        break;
    }

    return qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  async setActive(id: string, isActive: boolean): Promise<User> {
    await this.usersRepository.update(id, { isActive });
    const user = await this.findByIdForAdmin(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateByAdmin(
    id: string,
    dto: {
      isActive?: boolean;
      adminLastCalledAt?: string | null;
      adminCallNotes?: string | null;
    },
  ): Promise<User> {
    const updates: Partial<User> = {};
    if (dto.isActive !== undefined) updates.isActive = dto.isActive;
    if (dto.adminLastCalledAt !== undefined) {
      updates.adminLastCalledAt =
        dto.adminLastCalledAt === null ? null : new Date(dto.adminLastCalledAt);
    }
    if (dto.adminCallNotes !== undefined) {
      updates.adminCallNotes = dto.adminCallNotes;
    }
    if (Object.keys(updates).length === 0) {
      const u = await this.findByIdForAdmin(id);
      if (!u) throw new NotFoundException('User not found');
      return u;
    }
    await this.usersRepository.update(id, updates);
    const user = await this.findByIdForAdmin(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByIdWithRefreshToken(id: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.refreshTokenHash')
      .where('user.id = :id', { id })
      .getOne();
  }

  async updateGoogleId(id: string, googleId: string): Promise<void> {
    await this.usersRepository.update(id, { googleId });
  }

  async updateRefreshTokenHash(id: string, hash: string | null): Promise<void> {
    await this.usersRepository.update(id, { refreshTokenHash: hash });
  }

  async submitKyc(
    userId: string,
    dto: SubmitKycDto,
    documentUrl: string,
  ): Promise<User> {
    await this.usersRepository.update(userId, {
      businessName: dto.businessName,
      pan: dto.pan,
      gstin: dto.gstin ?? null,
      businessAddress: dto.businessAddress,
      websiteUrl: dto.websiteUrl ?? null,
      kycDocumentPath: documentUrl,
      kycStatus: KycStatus.PENDING,
      kycSubmittedAt: new Date(),
      kycRejectionReason: null,
    });
    const user = await this.usersRepository.findOneOrFail({
      where: { id: userId },
    });

    // Send acknowledgement email
    if (user.email && user.businessName) {
      this.emailService
        .sendKycSubmissionEmail(user.email, user.businessName)
        .catch((err) => {
          console.error(`Failed to send KYC submission email: ${err.message}`);
        });
    }

    return user;
  }

  async getKycDetails(userId: string): Promise<Partial<User>> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return {
      kycStatus: user.kycStatus,
      businessName: user.businessName,
      pan: user.pan,
      gstin: user.gstin,
      businessAddress: user.businessAddress,
      kycDocumentPath: user.kycDocumentPath,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycReviewedBy: user.kycReviewedBy,
      kycRejectionReason: user.kycRejectionReason,
    };
  }

  async findByKycStatus(
    status: KycStatus | undefined,
    page: number,
    limit: number,
    search?: string,
  ): Promise<[User[], number]> {
    let qb = this.usersRepository.createQueryBuilder('user');

    if (status) {
      qb = qb.andWhere('user.kycStatus = :status', { status });
    } else {
      qb = qb.andWhere('user.kycStatus != :notSubmitted', {
        notSubmitted: KycStatus.NOT_SUBMITTED,
      });
    }

    if (search) {
      qb = qb.andWhere(
        '(user.firstName ILIKE :search OR user.lastName ILIKE :search OR user.email ILIKE :search OR user.mobileNumber ILIKE :search OR user.businessName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    return qb
      .orderBy('user.kycSubmittedAt', 'DESC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  async reviewKyc(
    userId: string,
    adminUserId: string,
    action: 'approve' | 'reject',
    rejectionReason?: string,
  ): Promise<User> {
    const updateData: Partial<User> = {
      kycReviewedAt: new Date(),
      kycReviewedBy: adminUserId,
    };

    if (action === 'approve') {
      updateData.kycStatus = KycStatus.APPROVED;
      updateData.hasCompletedOnboarding = true;
    } else {
      updateData.kycStatus = KycStatus.REJECTED;
      updateData.kycRejectionReason = rejectionReason ?? null;
    }

    await this.usersRepository.update(userId, updateData);
    const user = await this.findByIdForAdmin(userId);
    if (!user) throw new NotFoundException('User not found');

    // Send status update email
    if (user.email && user.businessName) {
      this.emailService
        .sendKycStatusUpdateEmail(
          user.email,
          user.businessName,
          user.kycStatus,
          user.kycRejectionReason ?? undefined,
        )
        .catch((err) => {
          console.error(
            `Failed to send KYC status update email: ${err.message}`,
          );
        });
    }

    return user;
  }

  async countByKycStatus(status: KycStatus): Promise<number> {
    return this.usersRepository.count({ where: { kycStatus: status } });
  }

  async generateMobileOtp(
    userId: string,
    mobileNumber: string,
  ): Promise<string> {
    // Check if the mobile number is already in use by another account
    const existingUser = await this.usersRepository.findOne({
      where: { mobileNumber, id: Not(userId) },
    });
    if (existingUser) {
      throw new BadRequestException(
        'Mobile number is already associated with another account.',
      );
    }

    // Rate limit: max N OTPs per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await this.mobileOtpRepository.count({
      where: {
        userId,
        createdAt: MoreThan(oneHourAgo),
      },
    });
    if (recentCount >= this.otpMaxPerHour) {
      throw new BadRequestException(
        'Too many OTP requests. Please try again later.',
      );
    }

    // Cooldown: prevent spam resends
    const cooldownTime = new Date(Date.now() - this.otpCooldownSeconds * 1000);
    const recentOtp = await this.mobileOtpRepository.findOne({
      where: {
        userId,
        createdAt: MoreThan(cooldownTime),
      },
      order: { createdAt: 'DESC' },
    });
    if (recentOtp) {
      throw new BadRequestException(
        `Please wait ${this.otpCooldownSeconds} seconds before requesting a new OTP.`,
      );
    }

    const otp = String(randomInt(100000, 999999));
    const hash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + this.otpExpiryMinutes * 60 * 1000);

    // Update user's mobile number
    await this.usersRepository.update(userId, {
      mobileNumber,
      mobileVerified: false,
    });

    // Store OTP in DB
    const mobileOtp = this.mobileOtpRepository.create({
      userId,
      phoneNumber: mobileNumber,
      otpHash: hash,
      expiresAt,
      maxAttempts: this.otpMaxAttempts,
    });
    await this.mobileOtpRepository.save(mobileOtp);

    return otp;
  }

  async verifyMobileOtp(userId: string, otp: string): Promise<boolean> {
    // Find the latest non-verified, non-expired OTP
    const mobileOtp = await this.mobileOtpRepository
      .createQueryBuilder('otp')
      .addSelect('otp.otpHash')
      .where('otp.userId = :userId', { userId })
      .andWhere('otp.verified = false')
      .andWhere('otp.expiresAt > :now', { now: new Date() })
      .orderBy('otp.createdAt', 'DESC')
      .getOne();

    if (!mobileOtp) {
      throw new BadRequestException(
        'No valid OTP found. Please request a new one.',
      );
    }

    if (mobileOtp.attempts >= mobileOtp.maxAttempts) {
      throw new BadRequestException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    // Increment attempts
    mobileOtp.attempts += 1;

    const valid = await bcrypt.compare(otp, mobileOtp.otpHash);
    if (!valid) {
      await this.mobileOtpRepository.save(mobileOtp);
      const remaining = mobileOtp.maxAttempts - mobileOtp.attempts;
      throw new BadRequestException(
        `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      );
    }

    // Mark OTP as verified
    mobileOtp.verified = true;
    await this.mobileOtpRepository.save(mobileOtp);

    // Mark user as mobile verified
    await this.usersRepository.update(userId, { mobileVerified: true });

    return true;
  }

  async getOnboardingStatus(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');

    const steps = [
      {
        step: 1,
        title: 'Mobile Verification',
        completed: user.mobileVerified,
      },
      {
        step: 2,
        title: 'Business Details',
        completed:
          user.kycStatus === KycStatus.PENDING ||
          user.kycStatus === KycStatus.APPROVED,
      },
      {
        step: 3,
        title: 'Admin Approval',
        completed: user.kycStatus === KycStatus.APPROVED,
        support: {
          message:
            'Your documents are under review. Contact support for faster approval.',
          whatsapp: {
            number: '916376383348',
            url: 'https://wa.me/916376383348?text=Hi%2C%20I%20submitted%20my%20KYC%20for%20StartMessaging.%20Please%20review%20my%20documents.',
          },
        },
      },
    ];

    let currentStep: number;
    if (!user.mobileVerified) {
      currentStep = 1;
    } else if (
      user.kycStatus === KycStatus.NOT_SUBMITTED ||
      user.kycStatus === KycStatus.REJECTED
    ) {
      currentStep = 2;
    } else if (user.kycStatus === KycStatus.PENDING) {
      currentStep = 3;
    } else {
      currentStep = 3;
    }

    return {
      currentStep,
      isComplete: user.kycStatus === KycStatus.APPROVED,
      steps,
    };
  }

  async updateLastLogin(userId: string, lastLoginIp: string): Promise<void> {
    await this.usersRepository.update(userId, {
      lastLoginAt: new Date(),
      lastLoginIp,
    });
  }

  async getDashboardStats() {
    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [newToday, newThisWeek] = await Promise.all([
      this.usersRepository.count({
        where: { createdAt: MoreThan(todayStart) },
      }),
      this.usersRepository.count({
        where: { createdAt: MoreThan(sevenDaysAgo) },
      }),
    ]);

    return {
      newToday,
      newThisWeek,
    };
  }
}
