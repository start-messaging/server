import { Injectable } from '@nestjs/common';
import { istDayStart } from '../common/utils/date.util.js';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity.js';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import { User } from '../users/entities/user.entity.js';
import { EmailService } from '../common/services/email.service.js';

export class InsufficientBalanceError extends Error {
  code = ErrorCodes.INSUFFICIENT_BALANCE;
  constructor() {
    super('Insufficient wallet balance');
  }
}

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletTransaction)
    private readonly transactionRepository: Repository<WalletTransaction>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
  ) {}

  async createWallet(userId: string): Promise<Wallet> {
    const wallet = this.walletRepository.create({ userId });
    return this.walletRepository.save(wallet);
  }

  async getWallet(userId: string): Promise<Wallet> {
    const wallet = await this.walletRepository.findOne({ where: { userId } });
    if (!wallet) {
      return this.createWallet(userId);
    }
    return wallet;
  }

  /** Balances for many users (no row ⇒ 0). Used by admin user list. */
  async getBalancesByUserIds(userIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (userIds.length === 0) return map;
    for (const id of userIds) {
      map.set(id, 0);
    }
    const rows = await this.walletRepository.find({
      where: { userId: In(userIds) },
    });
    for (const w of rows) {
      map.set(w.userId, Number(w.balance));
    }
    return map;
  }

  async credit(
    userId: string,
    amount: number,
    description: string,
    referenceType?: string,
    referenceId?: string,
    manager?: EntityManager,
  ): Promise<WalletTransaction> {
    if (manager) {
      return this.performCredit(
        manager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    }
    return this.dataSource.transaction(async (txManager) => {
      return this.performCredit(
        txManager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    });
  }

  async debit(
    userId: string,
    amount: number,
    description: string,
    referenceType?: string,
    referenceId?: string,
    manager?: EntityManager,
  ): Promise<WalletTransaction> {
    if (manager) {
      return this.performDebit(
        manager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    }
    const tx = await this.dataSource.transaction(async (txManager) => {
      return this.performDebit(
        txManager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    });
    await this.sendLowBalanceAlertsIfNeeded(
      userId,
      tx.balanceBefore,
      tx.balanceAfter,
    );
    return tx;
  }

  async notifyLowBalanceIfNeeded(userId: string): Promise<void> {
    const wallet = await this.getWallet(userId);
    await this.sendLowBalanceAlertsIfNeeded(
      userId,
      Number(wallet.balance),
      Number(wallet.balance),
    );
  }

  private async performCredit(
    manager: EntityManager,
    userId: string,
    amount: number,
    description: string,
    referenceType?: string,
    referenceId?: string,
  ): Promise<WalletTransaction> {
    let wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.userId = :userId', { userId })
      .getOne();

    if (!wallet) {
      wallet = manager.getRepository(Wallet).create({ userId, balance: 0 });
      wallet = await manager.save(wallet);
    }

    const balanceBefore = Number(wallet.balance);
    const balanceAfter = balanceBefore + amount;

    wallet.balance = balanceAfter;
    await manager.save(wallet);

    const tx = manager.getRepository(WalletTransaction).create({
      walletId: wallet.id,
      type: WalletTransactionType.CREDIT,
      amount,
      balanceBefore,
      balanceAfter,
      referenceType: referenceType ?? null,
      referenceId: referenceId ?? null,
      description,
    });

    return manager.save(tx);
  }

  private async performDebit(
    manager: EntityManager,
    userId: string,
    amount: number,
    description: string,
    referenceType?: string,
    referenceId?: string,
  ): Promise<WalletTransaction> {
    let wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.userId = :userId', { userId })
      .getOne();

    if (!wallet) {
      wallet = manager.getRepository(Wallet).create({ userId, balance: 0 });
      wallet = await manager.save(wallet);
    }

    const balanceBefore = Number(wallet.balance);
    if (balanceBefore < amount) {
      throw new InsufficientBalanceError();
    }

    const balanceAfter = balanceBefore - amount;
    wallet.balance = balanceAfter;
    await manager.save(wallet);

    const tx = manager.getRepository(WalletTransaction).create({
      walletId: wallet.id,
      type: WalletTransactionType.DEBIT,
      amount,
      balanceBefore,
      balanceAfter,
      referenceType: referenceType ?? null,
      referenceId: referenceId ?? null,
      description,
    });

    return manager.save(tx);
  }

  private async sendLowBalanceAlertsIfNeeded(
    userId: string,
    balanceBefore: number,
    balanceAfter: number,
  ): Promise<void> {
    const threshold = this.getCrossedLowBalanceThreshold(
      balanceBefore,
      balanceAfter,
    );
    if (!threshold) return;

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user?.email) return;

    const displayName = user.businessName || user.firstName || 'there';
    await this.emailService.sendLowBalanceAlertEmail(
      user.email,
      displayName,
      balanceAfter,
      threshold,
    );
  }

  private getCrossedLowBalanceThreshold(
    before: number,
    after: number,
  ): number | null {
    // Balances are integer micros. Adjacent band crossing checks (₹5/₹3/₹1):
    // >5 -> (<5 and >3): send <5 alert
    // >3 -> (<3 and >1): send <3 alert
    // >1 -> (<1): send <1 alert
    const M = 1_000_000;
    if (before > 5 * M && after < 5 * M && after > 3 * M) return 5 * M;
    if (before > 3 * M && after < 3 * M && after > 1 * M) return 3 * M;
    if (before > 1 * M && after < 1 * M) return 1 * M;
    return null;
  }

  async getTransactionsAdmin(
    userId: string,
    page: number,
    limit: number,
  ): Promise<[WalletTransaction[], number]> {
    const wallet = await this.getWallet(userId);
    return this.transactionRepository.findAndCount({
      where: { walletId: wallet.id },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async getTransactions(
    userId: string,
    page: number,
    limit: number,
    type?: WalletTransactionType,
    startDate?: string,
    endDate?: string,
  ): Promise<[WalletTransaction[], number]> {
    const wallet = await this.getWallet(userId);
    const queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.walletId = :walletId', { walletId: wallet.id });

    if (type) {
      queryBuilder.andWhere('transaction.type = :type', { type });
    }

    if (startDate) {
      queryBuilder.andWhere('transaction.createdAt >= :startDate', {
        startDate,
      });
    }

    if (endDate) {
      queryBuilder.andWhere('transaction.createdAt <= :endDate', { endDate });
    }

    return queryBuilder
      .orderBy('transaction.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  async getAdminAnalytics() {
    const todayStart = istDayStart();

    const stats = await this.transactionRepository
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.amount), 0)', 'totalRevenue')
      .addSelect(
        `COALESCE(SUM(t.amount) FILTER (WHERE t.createdAt >= :todayStart), 0)`,
        'todayRevenue',
      )
      .where('t.type = :type', { type: WalletTransactionType.DEBIT }) // Debit means usage/revenue for platform
      .setParameter('todayStart', todayStart)
      .getRawOne();

    return {
      totalRevenue: parseFloat(stats.totalRevenue),
      todayRevenue: parseFloat(stats.todayRevenue),
    };
  }

  async getRevenueTrends(days = 7) {
    const startDate = istDayStart(days);

    const result = await this.transactionRepository
      .createQueryBuilder('t')
      .select(
        "TO_CHAR(t.createdAt AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')",
        'date',
      )
      .addSelect('COALESCE(SUM(t.amount), 0)', 'revenue')
      .where('t.type = :type', { type: WalletTransactionType.DEBIT })
      .andWhere('t.createdAt >= :startDate', { startDate })
      .groupBy("TO_CHAR(t.createdAt AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')")
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({
      date: r.date,
      revenue: parseFloat(r.revenue),
    }));
  }
}
