import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReferralPartner } from './entities/referral-partner.entity.js';
import { Referral } from './entities/referral.entity.js';
import { CommissionLedger } from './entities/commission-ledger.entity.js';
import { PayoutRequest } from './entities/payout-request.entity.js';
import { ReferralService } from './referral.service.js';
import { PartnerAuthService } from './partner-auth.service.js';
import { PartnerJwtStrategy } from './strategies/partner-jwt.strategy.js';
import { ReferralController } from './referral.controller.js';
import { PartnerAuthController } from './partner-auth.controller.js';
import { AdminReferralController } from './admin-referral.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReferralPartner,
      Referral,
      CommissionLedger,
      PayoutRequest,
    ]),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.get<string>('partnerJwt.secret'),
        signOptions: {
          expiresIn: (config.get<string>('partnerJwt.expiration') ??
            '1h') as any,
        },
      }),
    }),
  ],
  controllers: [
    PartnerAuthController,
    ReferralController,
    AdminReferralController,
  ],
  providers: [ReferralService, PartnerAuthService, PartnerJwtStrategy],
  exports: [ReferralService],
})
export class ReferralModule {}
