import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity.js';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';

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
    private readonly dataSource: DataSource,
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
    return this.dataSource.transaction(async (txManager) => {
      return this.performDebit(
        txManager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    });
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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const stats = await this.transactionRepository
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.amount), 0)', 'totalRevenue')
      .addSelect(`COALESCE(SUM(t.amount) FILTER (WHERE t.createdAt >= :todayStart), 0)`, 'todayRevenue')
      .where('t.type = :type', { type: WalletTransactionType.DEBIT }) // Debit means usage/revenue for platform
      .setParameter('todayStart', todayStart)
      .getRawOne();

    return {
      totalRevenue: parseFloat(stats.totalRevenue),
      todayRevenue: parseFloat(stats.todayRevenue),
    };
  }

  async getRevenueTrends(days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const result = await this.transactionRepository
      .createQueryBuilder('t')
      .select("TO_CHAR(t.createdAt, 'YYYY-MM-DD')", 'date')
      .addSelect('COALESCE(SUM(t.amount), 0)', 'revenue')
      .where('t.type = :type', { type: WalletTransactionType.DEBIT })
      .andWhere('t.createdAt >= :startDate', { startDate })
      .groupBy("TO_CHAR(t.createdAt, 'YYYY-MM-DD')")
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({
      date: r.date,
      revenue: parseFloat(r.revenue),
    }));
  }
}
