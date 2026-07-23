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
  ReferralPartner,
  ReferralPartnerStatus,
} from './entities/referral-partner.entity.js';
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

interface CreatePartnerFields {
  email: string;
  passwordHash: string;
  fullName: string;
  mobileNumber?: string | null;
}

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    @InjectRepository(ReferralPartner)
    private readonly partnerRepo: Repository<ReferralPartner>,
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

  // ── Partner creation (called by PartnerAuthService.register) ──

  /**
   * Create a partner with a freshly-allocated unique referral code. Email
   * uniqueness is pre-checked by the auth service; here we only retry on the
   * (extremely unlikely) referral-code collision.
   */
  async createPartnerWithCode(
    fields: CreatePartnerFields,
  ): Promise<ReferralPartner> {
    const { commissionBps } = this.cfg();
    for (let attempt = 0; attempt < 5; attempt++) {
      const partner = this.partnerRepo.create({
        email: fields.email,
        passwordHash: fields.passwordHash,
        fullName: fields.fullName,
        mobileNumber: fields.mobileNumber ?? null,
        status: ReferralPartnerStatus.ACTIVE,
        referralCode: this.generateCode(),
        commissionBps,
        earningsBalance: 0,
        totalEarned: 0,
        paidUsersCount: 0,
      });
      try {
        return await this.partnerRepo.save(partner);
      } catch (err: any) {
        // Retry only on a code collision; let an email collision surface.
        if (err?.code === '23505' && attempt < 4) continue;
        throw err;
      }
    }
    throw new BadRequestException('Could not allocate a referral code');
  }

  findPartnerByEmail(email: string): Promise<ReferralPartner | null> {
    return this.partnerRepo.findOne({
      where: { email: email.trim().toLowerCase() },
    });
  }

  findPartnerById(id: string): Promise<ReferralPartner | null> {
    return this.partnerRepo.findOne({ where: { id } });
  }

  async getPartnerOrThrow(id: string): Promise<ReferralPartner> {
    const partner = await this.findPartnerById(id);
    if (!partner) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_A_PARTNER,
        message: 'Partner account not found',
      });
    }
    return partner;
  }

  save(partner: ReferralPartner): Promise<ReferralPartner> {
    return this.partnerRepo.save(partner);
  }

  async updatePayoutDetails(
    partnerId: string,
    payoutDetails: Record<string, any>,
  ): Promise<ReferralPartner> {
    const partner = await this.getPartnerOrThrow(partnerId);
    partner.payoutDetails = payoutDetails;
    return this.partnerRepo.save(partner);
  }

  // ── Attribution (called at customer signup) ─────────────

  async attributeReferral(referredUserId: string, code: string): Promise<void> {
    const normalized = code.trim().toUpperCase();
    const partner = await this.partnerRepo.findOne({
      where: { referralCode: normalized },
    });
    if (!partner) return; // invalid code — ignore silently
    if (partner.status !== ReferralPartnerStatus.ACTIVE) return;

    const already = await this.referralRepo.findOne({
      where: { referredUserId },
    });
    if (already) return; // a user can only be referred once

    try {
      await this.referralRepo.save(
        this.referralRepo.create({
          partnerId: partner.id,
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

    const partnerRepo = manager.getRepository(ReferralPartner);
    const ledgerRepo = manager.getRepository(CommissionLedger);

    const idempotencyKey = `commission:${paymentId}`;
    const existing = await ledgerRepo.findOne({ where: { idempotencyKey } });
    if (existing) return;

    // Lock the partner row to serialise balance updates.
    const partner = await partnerRepo
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.id = :id', { id: referral.partnerId })
      .getOne();
    if (!partner || partner.status !== ReferralPartnerStatus.ACTIVE) return;

    const commission = Math.round(
      (baseAmountMicros * partner.commissionBps) / 10000,
    );

    // Mark the referral paid (first payment only).
    if (referral.status !== ReferralStatus.PAID) {
      referral.status = ReferralStatus.PAID;
      referral.firstPaidAt = new Date();
      partner.paidUsersCount += 1;
      await referralRepo.save(referral);
    }

    if (commission > 0) {
      const balanceAfter = Number(partner.earningsBalance) + commission;
      partner.earningsBalance = balanceAfter;
      partner.totalEarned = Number(partner.totalEarned) + commission;

      await ledgerRepo.save(
        ledgerRepo.create({
          partnerId: partner.id,
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

    await partnerRepo.save(partner);
  }

  // ── Partner reads ──────────────────────────────────────

  async getStats(partnerId: string) {
    const partner = await this.getPartnerOrThrow(partnerId);
    const cfg = this.cfg();
    const totalReferred = await this.referralRepo.count({
      where: { partnerId },
    });

    const meetsPaidUsers = partner.paidUsersCount >= cfg.minPaidUsers;
    const balance = Number(partner.earningsBalance);
    const meetsBalance = balance >= cfg.minWithdrawalMicros;
    const withinWindow = this.isWithinPayoutWindow(new Date());

    return {
      profile: {
        referralCode: partner.referralCode,
        status: partner.status,
        commissionPercent: partner.commissionBps / 100,
        payoutDetails: partner.payoutDetails,
      },
      totalReferred,
      paidUsersCount: partner.paidUsersCount,
      earningsBalanceMicros: balance,
      totalEarnedMicros: Number(partner.totalEarned),
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
    partnerId: string,
    page: number,
    limit: number,
  ): Promise<[Referral[], number]> {
    return this.referralRepo.findAndCount({
      where: { partnerId },
      relations: ['referredUser'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async listCommissions(
    partnerId: string,
    page: number,
    limit: number,
  ): Promise<[CommissionLedger[], number]> {
    return this.ledgerRepo.findAndCount({
      where: { partnerId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async listPayouts(
    partnerId: string,
    page: number,
    limit: number,
  ): Promise<[PayoutRequest[], number]> {
    return this.payoutRepo.findAndCount({
      where: { partnerId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  // ── Payout request (thresholds + window enforced here) ──

  async requestPayout(
    partnerId: string,
    payoutDetails?: Record<string, any>,
  ): Promise<PayoutRequest> {
    const cfg = this.cfg();
    const now = new Date();

    return this.dataSource.transaction(async (manager) => {
      const partnerRepo = manager.getRepository(ReferralPartner);
      const payoutRepo = manager.getRepository(PayoutRequest);
      const ledgerRepo = manager.getRepository(CommissionLedger);

      const partner = await partnerRepo
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id = :id', { id: partnerId })
        .getOne();
      if (!partner) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_A_PARTNER,
          message: 'Partner account not found',
        });
      }
      if (partner.status !== ReferralPartnerStatus.ACTIVE) {
        throw new ForbiddenException({
          code: ErrorCodes.PARTNER_SUSPENDED,
          message: 'Your partner account is suspended',
        });
      }

      const pending = await payoutRepo.findOne({
        where: { partnerId, status: PayoutStatus.REQUESTED },
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

      if (partner.paidUsersCount < cfg.minPaidUsers) {
        throw new ForbiddenException({
          code: ErrorCodes.PAYOUT_THRESHOLD_NOT_MET,
          message: `You need at least ${cfg.minPaidUsers} paid referred users to withdraw`,
          details: {
            required: cfg.minPaidUsers,
            current: partner.paidUsersCount,
          },
        });
      }

      const amount = Number(partner.earningsBalance);
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

      if (payoutDetails) partner.payoutDetails = payoutDetails;

      const payout = await payoutRepo.save(
        payoutRepo.create({
          partnerId,
          amount,
          currency: 'INR',
          status: PayoutStatus.REQUESTED,
          windowMonth: this.currentWindowMonth(now),
          payoutDetails: partner.payoutDetails,
        }),
      );

      // Move the balance out atomically so it can't be double-withdrawn.
      partner.earningsBalance = 0;
      await partnerRepo.save(partner);
      await ledgerRepo.save(
        ledgerRepo.create({
          partnerId,
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

  async listAllPartners(
    page: number,
    limit: number,
  ): Promise<[ReferralPartner[], number]> {
    return this.partnerRepo.findAndCount({
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
      const partnerRepo = manager.getRepository(ReferralPartner);
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
      const partner = await partnerRepo
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id = :id', { id: payout.partnerId })
        .getOne();
      if (partner) {
        const balanceAfter = Number(partner.earningsBalance) + payout.amount;
        partner.earningsBalance = balanceAfter;
        await partnerRepo.save(partner);
        await ledgerRepo.save(
          ledgerRepo.create({
            partnerId: payout.partnerId,
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
