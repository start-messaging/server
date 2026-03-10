import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity.js';
import { MobileOtp } from './entities/mobile-otp.entity.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { SmsProvidersModule } from '../sms-providers/sms-providers.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([User, MobileOtp]), SmsProvidersModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
