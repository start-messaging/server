import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';

import { AffiliateSettings } from './entities/affiliate-settings.entity.js';
import { Partner } from './entities/partner.entity.js';
import { Referral } from './entities/referral.entity.js';
import { ReferralClick } from './entities/referral-click.entity.js';
import { PartnerCommission } from './entities/partner-commission.entity.js';
import { PartnerPayout } from './entities/partner-payout.entity.js';

import { AffiliateSettingsService } from './services/affiliate-settings.service.js';
import { AttributionService } from './services/attribution.service.js';
import { PartnersService } from './services/partners.service.js';
import { AffiliateLedgerService } from './services/affiliate-ledger.service.js';
import { CommissionAccrualService } from './services/commission-accrual.service.js';
import { PartnerPayoutService } from './services/partner-payout.service.js';

import { PartnerAuthService } from './auth/partner-auth.service.js';
import { PartnerJwtStrategy } from './auth/partner-jwt.strategy.js';
import { PartnerAuthGuard } from './auth/partner-auth.guard.js';

import { AffiliatePublicController } from './controllers/affiliate-public.controller.js';
import { PartnerAuthController } from './controllers/partner-auth.controller.js';
import { PartnerController } from './controllers/partner.controller.js';
import { AdminAffiliateController } from './controllers/admin-affiliate.controller.js';

import { AFFILIATE_QUEUE } from './queues/affiliate.processor.js';
import { AffiliateProcessor } from './queues/affiliate.processor.js';
import { AffiliateSchedulerService } from './queues/affiliate-scheduler.service.js';
import { RedisModule } from '../common/redis.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AffiliateSettings,
      Partner,
      Referral,
      ReferralClick,
      PartnerCommission,
      PartnerPayout,
    ]),
    BullModule.registerQueue({ name: AFFILIATE_QUEUE }),
    PassportModule,
    RedisModule,
    // A JwtModule scoped to this module, signing with the partner secret.
    // Registering it here rather than reusing AuthModule's is what keeps
    // partner tokens unverifiable by the customer strategy.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.get<string>('partnerJwt.secret'),
        signOptions: {
          // Cast matches AuthModule: jsonwebtoken types `expiresIn` as a
          // template-literal union that a runtime config value cannot satisfy.
          expiresIn: (config.get<string>('partnerJwt.expiration') ??
            '1h') as never,
        },
      }),
    }),
  ],
  controllers: [
    AffiliatePublicController,
    PartnerAuthController,
    PartnerController,
    AdminAffiliateController,
  ],
  providers: [
    AffiliateSettingsService,
    AttributionService,
    PartnersService,
    AffiliateLedgerService,
    CommissionAccrualService,
    PartnerPayoutService,
    PartnerAuthService,
    PartnerJwtStrategy,
    PartnerAuthGuard,
    AffiliateProcessor,
    AffiliateSchedulerService,
  ],
  // AttributionService is exported so the customer signup flow can link a new
  // account to the partner whose cookie it carries.
  exports: [AttributionService, AffiliateSettingsService],
})
export class AffiliateModule {}
