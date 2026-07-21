import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReferralProfile } from './entities/referral-profile.entity.js';
import { Referral } from './entities/referral.entity.js';
import { CommissionLedger } from './entities/commission-ledger.entity.js';
import { PayoutRequest } from './entities/payout-request.entity.js';
import { ReferralService } from './referral.service.js';
import { ReferralController } from './referral.controller.js';
import { AdminReferralController } from './admin-referral.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReferralProfile,
      Referral,
      CommissionLedger,
      PayoutRequest,
    ]),
  ],
  controllers: [ReferralController, AdminReferralController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
