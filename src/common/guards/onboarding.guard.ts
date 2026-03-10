import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { SKIP_ONBOARDING_KEY } from '../decorators/skip-onboarding.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { UsersService } from '../../users/users.service.js';
import { UserRole } from '../../users/enums/user-role.enum.js';
import { KycStatus } from '../../users/enums/kyc-status.enum.js';
import { ErrorCodes } from '../constants/error-codes.constant.js';

@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(UsersService)
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const skipOnboarding = this.reflector.getAllAndOverride<boolean>(
      SKIP_ONBOARDING_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skipOnboarding) return true;

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredRoles?.includes('admin')) return true;

    const request = context.switchToHttp().getRequest();
    const reqUser = request.user;
    if (!reqUser) return true;

    if (reqUser.role === UserRole.ADMIN || reqUser.role === UserRole.REFERRER) {
      return true;
    }

    const user = await this.usersService.findById(reqUser.id);
    if (!user) return true;

    if (user.kycStatus === KycStatus.APPROVED) return true;

    let currentStep: number;
    let stepMessage: string;

    if (!user.mobileVerified) {
      currentStep = 1;
      stepMessage = 'Mobile verification required';
    } else if (
      user.kycStatus === KycStatus.NOT_SUBMITTED ||
      user.kycStatus === KycStatus.REJECTED
    ) {
      currentStep = 2;
      stepMessage = 'KYC submission required';
    } else {
      currentStep = 3;
      stepMessage = 'KYC approval pending';
    }

    throw new ForbiddenException({
      errorCode: ErrorCodes.ONBOARDING_INCOMPLETE,
      message: stepMessage,
      currentStep,
    });
  }
}
