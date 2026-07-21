import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  ReferralProfile,
  ReferralProfileStatus,
} from './entities/referral-profile.entity.js';
import { Referral, ReferralStatus } from './entities/referral.entity.js';
import {
  CommissionLedger,
  CommissionType,
} from './entities/commission-ledger.entity.js';
import {
  PayoutRequest,
  PayoutStatus,
} from './entities/payout-request.entity.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';

interface AffiliateConfig {
  commissionBps: number;
  minPaidUsers: number;
  minWithdrawalMicros: number;
  startDay: number;
  endDay: number;
}

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    @InjectRepository(ReferralProfile)
    private readonly profileRepo: Repository<ReferralProfile>,
    @InjectRepository(Referral)
    private readonly referralRepo: Repository<Referral>,
    @InjectRepository(CommissionLedger)
    private readonly ledgerRepo: Repository<CommissionLedger>,
    @InjectRepository(PayoutRequest)
    private readonly payoutRepo: Repository<PayoutRequest>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  private cfg(): AffiliateConfig {
    return {
      commissionBps: Math.round(
        (this.config.get<number>('affiliate.commissionPercent') ?? 10) * 100,
      ),
      minPaidUsers: this.config.get<number>('affiliate.minPaidUsers') ?? 10,
      minWithdrawalMicros: Math.round(
        (this.config.get<number>('affiliate.minWithdrawal') ?? 1000) *
          1_000_000,
      ),
      startDay:
        this.config.get<number>('affiliate.payoutWindow.startDay') ?? 21,
      endDay: this.config.get<number>('affiliate.payoutWindow.endDay') ?? 28,
    };
  }

  private isWithinPayoutWindow(now: Date): boolean {
    const { startDay, endDay } = this.cfg();
    const day = now.getUTCDate();
    return day >= startDay && day <= endDay;
  }

  private currentWindowMonth(now: Date): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private generateCode(): string {
    // 8 uppercase base32-ish chars, no ambiguous 0/O/1/I.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
    return code;
  }

  // ── Join / profile ─────────────────────────────────────

  async joinProgram(
    userId: string,
    payoutDetails?: Record<string, any>,
  ): Promise<ReferralProfile> {
    const existing = await this.profileRepo.findOne({ where: { userId } });
    if (existing) {
      throw new BadRequestException({
        code: ErrorCodes.ALREADY_A_PARTNER,
        message: 'You have already joined the affiliate program',
      });
    }

    const { commissionBps } = this.cfg();
    // Retry on the (extremely unlikely) referral-code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const referralCode = this.generateCode();
      const profile = this.profileRepo.create({
        userId,
        referralCode,
        status: ReferralProfileStatus.ACTIVE,
        commissionBps,
        earningsBalance: 0,
        totalEarned: 0,
        paidUsersCount: 0,
        payoutDetails: payoutDetails ?? null,
      });
      try {
        return await this.profileRepo.save(profile);
      } catch (err: any) {
        if (err?.code === '23505' && attempt < 4) continue; // unique violation
        throw err;
      }
    }
    throw new BadRequestException('Could not allocate a referral code');
  }

  getProfileOrNull(userId: string): Promise<ReferralProfile | null> {
    return this.profileRepo.findOne({ where: { userId } });
  }

  async getProfileOrThrow(userId: string): Promise<ReferralProfile> {
    const profile = await this.getProfileOrNull(userId);
    if (!profile) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_A_PARTNER,
        message: 'You have not joined the affiliate program',
      });
    }
    return profile;
  }

  // ── Attribution (called at signup) ─────────────────────

  async attributeReferral(referredUserId: string, code: string): Promise<void> {
    const normalized = code.trim().toUpperCase();
    const profile = await this.profileRepo.findOne({
      where: { referralCode: normalized },
    });
    if (!profile) return; // invalid code — ignore silently
    if (profile.status !== ReferralProfileStatus.ACTIVE) return;
    if (profile.userId === referredUserId) return; // no self-referral

    const already = await this.referralRepo.findOne({
      where: { referredUserId },
    });
    if (already) return; // a user can only be referred once

    try {
      await this.referralRepo.save(
        this.referralRepo.create({
          partnerUserId: profile.userId,
          referredUserId,
          referralCode: normalized,
          status: ReferralStatus.SIGNED_UP,
        }),
      );
    } catch (err: any) {
      if (err?.code === '23505') return; // raced; already attributed
      throw err;
    }
  }

  // ── Commission accrual (called after a payment completes) ──

  /**
   * Credit the referring partner when a referred user pays. Runs inside the
   * caller's payment transaction (same `manager`). Idempotent per payment.
   */
  async recordCommissionForPayment(
    manager: EntityManager,
    payerUserId: string,
    paymentId: string,
    baseAmountMicros: number,
  ): Promise<void> {
    const referralRepo = manager.getRepository(Referral);
    const referral = await referralRepo.findOne({
      where: { referredUserId: payerUserId },
    });
    if (!referral) return;

    const profileRepo = manager.getRepository(ReferralProfile);
    const ledgerRepo = manager.getRepository(CommissionLedger);

    const idempotencyKey = `commission:${paymentId}`;
    const existing = await ledgerRepo.findOne({ where: { idempotencyKey } });
    if (existing) return;

    // Lock the partner's profile row to serialise balance updates.
    const profile = await profileRepo
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.userId = :userId', { userId: referral.partnerUserId })
      .getOne();
    if (!profile || profile.status !== ReferralProfileStatus.ACTIVE) return;

    const commission = Math.round(
      (baseAmountMicros * profile.commissionBps) / 10000,
    );

    // Mark the referral paid (first payment only).
    if (referral.status !== ReferralStatus.PAID) {
      referral.status = ReferralStatus.PAID;
      referral.firstPaidAt = new Date();
      profile.paidUsersCount += 1;
      await referralRepo.save(referral);
    }

    if (commission > 0) {
      const balanceAfter = Number(profile.earningsBalance) + commission;
      profile.earningsBalance = balanceAfter;
      profile.totalEarned = Number(profile.totalEarned) + commission;

      await ledgerRepo.save(
        ledgerRepo.create({
          partnerUserId: profile.userId,
          type: CommissionType.EARN,
          amount: commission,
          balanceAfter,
          referredUserId: payerUserId,
          paymentId,
          idempotencyKey,
          description: 'Referral commission',
        }),
      );
    }

    await profileRepo.save(profile);
  }

  // ── Partner reads ──────────────────────────────────────

  async getStats(userId: string) {
    const profile = await this.getProfileOrThrow(userId);
    const cfg = this.cfg();
    const totalReferred = await this.referralRepo.count({
      where: { partnerUserId: userId },
    });

    const meetsPaidUsers = profile.paidUsersCount >= cfg.minPaidUsers;
    const balance = Number(profile.earningsBalance);
    const meetsBalance = balance >= cfg.minWithdrawalMicros;
    const withinWindow = this.isWithinPayoutWindow(new Date());

    return {
      profile: {
        referralCode: profile.referralCode,
        status: profile.status,
        commissionPercent: profile.commissionBps / 100,
        payoutDetails: profile.payoutDetails,
      },
      totalReferred,
      paidUsersCount: profile.paidUsersCount,
      earningsBalanceMicros: balance,
      totalEarnedMicros: Number(profile.totalEarned),
      eligibility: {
        minPaidUsers: cfg.minPaidUsers,
        meetsPaidUsers,
        minWithdrawalMicros: cfg.minWithdrawalMicros,
        meetsBalance,
        withinWindow,
        canRequestPayout: meetsPaidUsers && meetsBalance && withinWindow,
      },
      payoutWindow: { startDay: cfg.startDay, endDay: cfg.endDay },
    };
  }

  async listReferrals(
    userId: string,
    page: number,
    limit: number,
  ): Promise<[Referral[], number]> {
    return this.referralRepo.findAndCount({
      where: { partnerUserId: userId },
      relations: ['referredUser'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async listCommissions(
    userId: string,
    page: number,
    limit: number,
  ): Promise<[CommissionLedger[], number]> {
    return this.ledgerRepo.findAndCount({
      where: { partnerUserId: userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async listPayouts(
    userId: string,
    page: number,
    limit: number,
  ): Promise<[PayoutRequest[], number]> {
    return this.payoutRepo.findAndCount({
      where: { partnerUserId: userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  // ── Payout request (thresholds + window enforced here) ──

  async requestPayout(
    userId: string,
    payoutDetails?: Record<string, any>,
  ): Promise<PayoutRequest> {
    const cfg = this.cfg();
    const now = new Date();

    return this.dataSource.transaction(async (manager) => {
      const profileRepo = manager.getRepository(ReferralProfile);
      const payoutRepo = manager.getRepository(PayoutRequest);
      const ledgerRepo = manager.getRepository(CommissionLedger);

      const profile = await profileRepo
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.userId = :userId', { userId })
        .getOne();
      if (!profile) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_A_PARTNER,
          message: 'You have not joined the affiliate program',
        });
      }
      if (profile.status !== ReferralProfileStatus.ACTIVE) {
        throw new ForbiddenException({
          code: ErrorCodes.PARTNER_SUSPENDED,
          message: 'Your partner account is suspended',
        });
      }

      const pending = await payoutRepo.findOne({
        where: { partnerUserId: userId, status: PayoutStatus.REQUESTED },
      });
      if (pending) {
        throw new BadRequestException({
          code: ErrorCodes.PAYOUT_PENDING_EXISTS,
          message: 'You already have a pending payout request',
        });
      }

      if (!this.isWithinPayoutWindow(now)) {
        throw new ForbiddenException({
          code: ErrorCodes.PAYOUT_WINDOW_CLOSED,
          message: `Payouts can only be requested between day ${cfg.startDay} and ${cfg.endDay} of the month`,
          details: { startDay: cfg.startDay, endDay: cfg.endDay },
        });
      }

      if (profile.paidUsersCount < cfg.minPaidUsers) {
        throw new ForbiddenException({
          code: ErrorCodes.PAYOUT_THRESHOLD_NOT_MET,
          message: `You need at least ${cfg.minPaidUsers} paid referred users to withdraw`,
          details: {
            required: cfg.minPaidUsers,
            current: profile.paidUsersCount,
          },
        });
      }

      const amount = Number(profile.earningsBalance);
      if (amount < cfg.minWithdrawalMicros) {
        throw new BadRequestException({
          code: ErrorCodes.PAYOUT_MIN_BALANCE_NOT_MET,
          message: 'Your balance is below the minimum withdrawal amount',
          details: {
            minWithdrawalMicros: cfg.minWithdrawalMicros,
            balanceMicros: amount,
          },
        });
      }

      if (payoutDetails) profile.payoutDetails = payoutDetails;

      const payout = await payoutRepo.save(
        payoutRepo.create({
          partnerUserId: userId,
          amount,
          currency: 'INR',
          status: PayoutStatus.REQUESTED,
          windowMonth: this.currentWindowMonth(now),
          payoutDetails: profile.payoutDetails,
        }),
      );

      // Move the balance out atomically so it can't be double-withdrawn.
      profile.earningsBalance = 0;
      await profileRepo.save(profile);
      await ledgerRepo.save(
        ledgerRepo.create({
          partnerUserId: userId,
          type: CommissionType.WITHDRAWAL,
          amount,
          balanceAfter: 0,
          payoutId: payout.id,
          idempotencyKey: `payout:${payout.id}`,
          description: 'Payout request',
        }),
      );

      return payout;
    });
  }

  // ── Admin ──────────────────────────────────────────────

  async listAllProfiles(
    page: number,
    limit: number,
  ): Promise<[ReferralProfile[], number]> {
    return this.profileRepo.findAndCount({
      relations: ['user'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async listAllPayouts(
    page: number,
    limit: number,
    status?: PayoutStatus,
  ): Promise<[PayoutRequest[], number]> {
    return this.payoutRepo.findAndCount({
      where: status ? { status } : {},
      relations: ['partner'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async approvePayout(
    payoutId: string,
    adminId: string,
    payoutRef?: string,
  ): Promise<PayoutRequest> {
    const payout = await this.payoutRepo.findOne({ where: { id: payoutId } });
    if (!payout) {
      throw new NotFoundException({
        code: ErrorCodes.PAYOUT_NOT_FOUND,
        message: 'Payout request not found',
      });
    }
    if (payout.status !== PayoutStatus.REQUESTED) {
      throw new BadRequestException('Payout is not in a requestable state');
    }
    payout.status = PayoutStatus.PAID;
    payout.payoutRef = payoutRef ?? null;
    payout.processedAt = new Date();
    payout.processedBy = adminId;
    return this.payoutRepo.save(payout);
  }

  async rejectPayout(
    payoutId: string,
    adminId: string,
    reason: string,
  ): Promise<PayoutRequest> {
    return this.dataSource.transaction(async (manager) => {
      const payoutRepo = manager.getRepository(PayoutRequest);
      const profileRepo = manager.getRepository(ReferralProfile);
      const ledgerRepo = manager.getRepository(CommissionLedger);

      const payout = await payoutRepo.findOne({ where: { id: payoutId } });
      if (!payout) {
        throw new NotFoundException({
          code: ErrorCodes.PAYOUT_NOT_FOUND,
          message: 'Payout request not found',
        });
      }
      if (payout.status !== PayoutStatus.REQUESTED) {
        throw new BadRequestException('Payout is not in a requestable state');
      }

      payout.status = PayoutStatus.REJECTED;
      payout.rejectionReason = reason;
      payout.processedAt = new Date();
      payout.processedBy = adminId;
      await payoutRepo.save(payout);

      // Return the funds to the partner's balance.
      const profile = await profileRepo
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.userId = :userId', { userId: payout.partnerUserId })
        .getOne();
      if (profile) {
        const balanceAfter = Number(profile.earningsBalance) + payout.amount;
        profile.earningsBalance = balanceAfter;
        await profileRepo.save(profile);
        await ledgerRepo.save(
          ledgerRepo.create({
            partnerUserId: payout.partnerUserId,
            type: CommissionType.REVERSAL,
            amount: payout.amount,
            balanceAfter,
            payoutId: payout.id,
            idempotencyKey: `payout-reversal:${payout.id}`,
            description: 'Payout rejected — funds returned',
          }),
        );
      }

      return payout;
    });
  }
}
