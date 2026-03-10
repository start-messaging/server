import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { UsersService } from './users.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';
import { excludePassword } from '../common/utils/user.util.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { SubmitKycDto } from './dto/submit-kyc.dto.js';
import { SendMobileOtpDto } from './dto/send-mobile-otp.dto.js';
import { VerifyMobileOtpDto } from './dto/verify-mobile-otp.dto.js';
import { R2UploadService } from '../common/services/r2-upload.service.js';
import { SmsProviderFactory } from '../sms-providers/sms-provider.factory.js';
import { KycStatus } from './enums/kyc-status.enum.js';

@ApiTags('Users')
@ApiBearerAuth()
@SkipOnboarding()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly r2UploadService: R2UploadService,
    private readonly smsProviderFactory: SmsProviderFactory,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  async getMe(@CurrentUser('id') userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) return null;
    return excludePassword(user);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateMe(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    const user = await this.usersService.update(userId, dto);
    return excludePassword(user);
  }

  @Post('send-mobile-otp')
  @ApiOperation({ summary: 'Send OTP to mobile number for verification' })
  async sendMobileOtp(
    @CurrentUser('id') userId: string,
    @Body() dto: SendMobileOtpDto,
  ) {
    // Generate OTP and store in DB (handles rate limiting + cooldown)
    const otp = await this.usersService.generateMobileOtp(
      userId,
      dto.mobileNumber,
    );

    // Send via Fast2SMS — OTP code embedded in message for provider to extract
    const result = await this.smsProviderFactory.send({
      to: dto.mobileNumber,
      content: `Your StartMessaging verification code is ${otp}. Valid for 5 minutes.`,
    });

    if (result.status === 'failed') {
      throw new BadRequestException(
        result.failureReason ?? 'Failed to send OTP. Please try again.',
      );
    }

    return {
      sent: true,
      message: 'OTP sent successfully',
    };
  }

  @Post('verify-mobile-otp')
  @ApiOperation({ summary: 'Verify mobile OTP' })
  async verifyMobileOtp(
    @CurrentUser('id') userId: string,
    @Body() dto: VerifyMobileOtpDto,
  ) {
    // Throws BadRequestException with descriptive messages on failure
    await this.usersService.verifyMobileOtp(userId, dto.otp);
    const user = await this.usersService.findById(userId);
    return excludePassword(user!);
  }

  @Get('onboarding-status')
  @ApiOperation({ summary: 'Get onboarding progress' })
  async getOnboardingStatus(@CurrentUser('id') userId: string) {
    return this.usersService.getOnboardingStatus(userId);
  }

  @Post('kyc')
  @ApiOperation({ summary: 'Submit KYC documents' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('document', { storage: memoryStorage() }))
  async submitKyc(
    @CurrentUser('id') userId: string,
    @Body() dto: SubmitKycDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: '.(pdf|jpg|jpeg|png)' }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const currentUser = await this.usersService.findById(userId);

    if (!currentUser?.mobileVerified) {
      throw new BadRequestException(
        'Mobile verification is required before submitting KYC',
      );
    }

    if (
      currentUser.kycStatus === KycStatus.PENDING ||
      currentUser.kycStatus === KycStatus.APPROVED
    ) {
      throw new BadRequestException('KYC already submitted or approved');
    }

    const ext = file.originalname.split('.').pop();
    const key = `kyc/${userId}/${Date.now()}.${ext}`;
    const documentUrl = await this.r2UploadService.upload(
      key,
      file.buffer,
      file.mimetype,
    );

    const user = await this.usersService.submitKyc(userId, dto, documentUrl);
    return excludePassword(user);
  }

  @Get('kyc')
  @ApiOperation({ summary: 'Get current user KYC details' })
  async getKycDetails(@CurrentUser('id') userId: string) {
    return this.usersService.getKycDetails(userId);
  }
}
