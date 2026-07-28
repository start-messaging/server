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
import {
  applySort,
  paginateQueryBuilder,
  resolveSort,
  SortWhitelist,
} from '../common/utils/pagination.util.js';
import { COUNT_SKIPPED } from '../common/constants/pagination.constants.js';

/** Sort keys the transaction lists may order by. */
const TRANSACTION_SORT_WHITELIST: SortWhitelist = {
  created_at: 'transaction.createdAt',
  amount: 'transaction.amount',
  type: 'transaction.type',
  balance_after: 'transaction.balanceAfter',
};

export interface TransactionFilters {
  type?: WalletTransactionType;
  startDate?: string;
  endDate?: string;
  referenceType?: string;
  search?: string;
}

/** Everything a transaction list query needs, in one object. */
export interface TransactionQuery extends TransactionFilters {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: string;
  /** Defaults to true. */
  withCount?: boolean;
}

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
    // Adjacent band crossing checks:
    // >5 -> (<5 and >3): send <5 alert
    // >3 -> (<3 and >1): send <3 alert
    // >1 -> (<1): send <1 alert
    if (before > 5 && after < 5 && after > 3) return 5;
    if (before > 3 && after < 3 && after > 1) return 3;
    if (before > 1 && after < 1) return 1;
    return null;
  }

  /**
   * Resolves a user's wallet id without creating one.
   *
   * `getWallet` inserts a wallet when none exists, which is right on the
   * write paths but wrong on a read: listing transactions should not have the
   * side effect of writing a row, and doing so makes GET requests fail against
   * a read replica or a read-only transaction.
   */
  private async findWalletId(userId: string): Promise<string | null> {
    const wallet = await this.walletRepository.findOne({
      where: { userId },
      select: { id: true },
    });
    return wallet?.id ?? null;
  }

  /** Admin view of a customer's wallet history. Same query shape. */
  async getTransactionsAdmin(
    userId: string,
    query: TransactionQuery,
  ): Promise<[WalletTransaction[], number]> {
    return this.queryTransactions(userId, query);
  }

  /**
   * Customer-facing wallet history.
   *
   * Takes a single options object rather than a positional parameter list.
   * The earlier positional form silently dropped filters: adding `search` to
   * the DTO without threading it through nine positional arguments meant the
   * endpoint accepted the parameter, validated it, and then ignored it —
   * returning every row as if it had matched.
   */
  async getTransactions(
    userId: string,
    query: TransactionQuery,
  ): Promise<[WalletTransaction[], number]> {
    return this.queryTransactions(userId, query);
  }

  private async queryTransactions(
    userId: string,
    query: TransactionQuery,
  ): Promise<[WalletTransaction[], number]> {
    const { page, limit, sortBy, sortOrder, withCount = true, ...filters } =
      query;

    const walletId = await this.findWalletId(userId);
    // No wallet yet means no transactions — an empty page, not an error.
    if (!walletId) return [[], withCount ? 0 : COUNT_SKIPPED];

    const qb = this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.walletId = :walletId', { walletId });

    if (filters.type) {
      qb.andWhere('transaction.type = :type', { type: filters.type });
    }
    if (filters.startDate) {
      qb.andWhere('transaction.createdAt >= :startDate', {
        startDate: new Date(filters.startDate),
      });
    }
    if (filters.endDate) {
      qb.andWhere('transaction.createdAt <= :endDate', {
        endDate: new Date(filters.endDate),
      });
    }
    if (filters.referenceType) {
      qb.andWhere('transaction.referenceType = :referenceType', {
        referenceType: filters.referenceType,
      });
    }
    if (filters.search?.trim()) {
      qb.andWhere('transaction.description ILIKE :search', {
        search: `%${filters.search.trim()}%`,
      });
    }

    applySort(
      qb,
      resolveSort(sortBy, TRANSACTION_SORT_WHITELIST, 'created_at', sortOrder),
    );
    qb.addOrderBy('transaction.id', 'DESC');

    return paginateQueryBuilder(qb, { page, limit, withCount });
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
