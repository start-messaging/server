import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
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

// `InsufficientBalanceError` was removed with the throw that raised it. It had
// exactly one thrower — the settlement debit, which now books the charge and
// lets the balance go negative rather than refusing a send that has already
// happened. `ErrorCodes.INSUFFICIENT_BALANCE` is untouched and still guards the
// send itself in OtpService, which is the point where refusing actually saves
// the money.

/** What came of asking for a debit that may only ever be raised once. */
export interface ReferencedDebit {
  /**
   * The ledger entry that holds this charge — the one just written, or the
   * one that was already there. Callers copy their record of the cost from
   * this rather than from what they asked for, so the row they own and the
   * ledger cannot drift apart.
   */
  transaction: WalletTransaction;
  /** False when the reference had already been charged and no money moved. */
  charged: boolean;
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

  /**
   * Returns the account's wallet, creating it if the account has none.
   *
   * INSERT ... ON CONFLICT DO NOTHING followed by a read, never a bare INSERT.
   * Two first reads of the same account arriving together both saw no row,
   * both inserted, and the loser broke UQ_wallets_userId — a 500 answered to
   * a GET, which a dashboard mounting the balance widget twice was enough to
   * produce. The database decides which of them inserts; both then read the
   * same row back and neither fails.
   */
  async createWallet(userId: string): Promise<Wallet> {
    await this.walletRepository
      .createQueryBuilder()
      .insert()
      .into(Wallet)
      .values({ userId })
      .orIgnore()
      .execute();

    const wallet = await this.walletRepository.findOne({ where: { userId } });
    if (!wallet) {
      // Only reachable if the row was deleted between the insert and this
      // read. Returning a detached entity here would hand the caller a
      // balance with no row behind it, which is worse than saying so.
      throw new NotFoundException({
        code: ErrorCodes.WALLET_NOT_FOUND,
        message: 'Wallet not found',
      });
    }
    return wallet;
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

  /**
   * Debits at most once for a given (referenceType, referenceId).
   *
   * This is the only debit entrance, and it takes a reference because there is
   * no safe debit without one. The previous shape took the reference as two
   * optional trailing arguments and never read them: the caller decided
   * whether to charge, from an entity it had loaded outside the transaction,
   * and asked "has this message already been delivered?" — which answers "no"
   * twice when a provider sends delivered → failed → delivered, and "no" to
   * both of two status checks that arrive together. Each of those billed one
   * SMS twice.
   *
   * The question that protects money is "has this reference already been
   * charged?", and it is answered here, under the wallet lock, against the
   * ledger itself — with the partial unique index behind it (see
   * 1786600000000-OneDebitPerMessage) as the authority no caller can route
   * around.
   */
  async debitForReference(
    userId: string,
    amount: number,
    description: string,
    referenceType: string,
    referenceId: string,
    manager?: EntityManager,
  ): Promise<ReferencedDebit> {
    if (manager) {
      return this.performReferencedDebit(
        manager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    }
    const outcome = await this.dataSource.transaction(async (txManager) => {
      return this.performReferencedDebit(
        txManager,
        userId,
        amount,
        description,
        referenceType,
        referenceId,
      );
    });
    // Only a charge that actually moved money can cross a threshold.
    if (outcome.charged) {
      await this.sendLowBalanceAlertsIfNeeded(
        userId,
        Number(outcome.transaction.balanceBefore),
        Number(outcome.transaction.balanceAfter),
      );
    }
    return outcome;
  }

  async notifyLowBalanceIfNeeded(
    userId: string,
    balanceBefore: number,
    balanceAfter: number,
  ): Promise<void> {
    // The two figures come from the ledger entry the caller just booked, and
    // they have to be the real pair.
    //
    // This used to read the wallet and pass the same balance as both, which
    // made the alert structurally impossible to send: every band test is a
    // crossing (`before > 5 && after < 5`), and no number is on both sides of
    // a threshold. So the one warning that tells a customer they are running
    // out has never fired — which is exactly the warning that would keep a
    // wallet from reaching the overdraft the settlement debit now permits.
    await this.sendLowBalanceAlertsIfNeeded(
      userId,
      balanceBefore,
      balanceAfter,
    );
  }

  /**
   * Takes the wallet row FOR UPDATE, creating it first if the account has none.
   *
   * Every money path enters through here. The lock is the whole of the defence
   * against lost updates — six delivery reports arriving together otherwise
   * all read the same opening balance and five of the six subtractions vanish
   * — so nothing may read a balance it is about to change without holding it.
   *
   * The insert is ON CONFLICT DO NOTHING for the same reason getWallet's is,
   * with one extra consequence here: a unique violation inside a transaction
   * aborts it outright, so two first debits for an account with no wallet yet
   * would roll a message status write back along with the charge.
   */
  private async lockWallet(
    manager: EntityManager,
    userId: string,
  ): Promise<Wallet> {
    const lock = () =>
      manager
        .getRepository(Wallet)
        .createQueryBuilder('wallet')
        .setLock('pessimistic_write')
        .where('wallet.userId = :userId', { userId })
        .getOne();

    const existing = await lock();
    if (existing) return existing;

    await manager
      .createQueryBuilder()
      .insert()
      .into(Wallet)
      .values({ userId, balance: 0 })
      .orIgnore()
      .execute();

    const wallet = await lock();
    if (!wallet) {
      throw new NotFoundException({
        code: ErrorCodes.WALLET_NOT_FOUND,
        message: 'Wallet not found',
      });
    }
    return wallet;
  }

  private async performCredit(
    manager: EntityManager,
    userId: string,
    amount: number,
    description: string,
    referenceType?: string,
    referenceId?: string,
  ): Promise<WalletTransaction> {
    const wallet = await this.lockWallet(manager, userId);

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

  private async performReferencedDebit(
    manager: EntityManager,
    userId: string,
    amount: number,
    description: string,
    referenceType: string,
    referenceId: string,
  ): Promise<ReferencedDebit> {
    const wallet = await this.lockWallet(manager, userId);
    const transactions = manager.getRepository(WalletTransaction);
    const charge = {
      walletId: wallet.id,
      type: WalletTransactionType.DEBIT,
      referenceType,
      referenceId,
    };

    // Asked before the balance is so much as looked at, and asked while
    // holding the wallet lock — which is what makes the answer true. A second
    // request queued behind the first resumes here after that first debit has
    // committed, and READ COMMITTED gives this statement a fresh snapshot, so
    // it sees the charge rather than a still-sufficient balance.
    const alreadyCharged = await transactions.findOne({ where: charge });
    if (alreadyCharged) {
      return { transaction: alreadyCharged, charged: false };
    }

    const balanceBefore = Number(wallet.balance);
    // This debit is allowed to take the balance negative, and that is the
    // point of it.
    //
    // `debitForReference` has exactly one caller: settling a message that
    // 2Factor has already delivered. The SMS is sent, the handset has it, and
    // we have already paid the provider — so by the time this runs, refusing
    // the charge does not save the money, it only loses the record of it. It
    // used to throw here, and because the ledger insert travels in the same
    // transaction as the message's status write, the throw rolled the status
    // write back with it: the webhook was retried three times in ten seconds
    // against the same empty wallet, then deleted with `removeOnFail`. The
    // message stayed at `sent` for ever — 2Factor sends the report once, and
    // the reconcile sweep cannot recover it because its report API answers
    // `unknown` for OTP-endpoint session ids. Net: an SMS we paid for, never
    // billed, and a customer watching a message that never resolves.
    //
    // Two sends against a single OTP's worth of balance is all it takes: both
    // pass the pre-send check, because neither reserves anything.
    //
    // What keeps the overdraft small is that the pre-send check in
    // OtpService.send refuses on `balance < costPerOtp`, and a negative
    // balance is comfortably less than the cost — so an account in arrears
    // cannot send at all. The debt is bounded by whatever was already in
    // flight, and the next top-up credits straight through it.
    const balanceAfter = balanceBefore - amount;

    // The ledger entry is written before the balance moves, and its insert
    // carries ON CONFLICT DO NOTHING so the partial unique index — not the
    // check above — has the last word: a writer that never took this lock (a
    // second instance, a repair script) still cannot book a second charge for
    // the same reference, and it is refused by being skipped rather than by
    // raising 23505, which inside a transaction would abort the status write
    // travelling with it.
    //
    // The id is minted here rather than by the default, so that comparing it
    // with what came back says which of the two happened without depending on
    // how the driver reports a skipped insert.
    const id = randomUUID();
    await manager
      .createQueryBuilder()
      .insert()
      .into(WalletTransaction)
      .values({
        id,
        ...charge,
        amount,
        balanceBefore,
        balanceAfter,
        description,
      })
      .orIgnore()
      .execute();

    const stored = await transactions.findOneOrFail({ where: charge });
    if (stored.id !== id) {
      return { transaction: stored, charged: false };
    }

    wallet.balance = balanceAfter;
    await manager.save(wallet);

    return { transaction: stored, charged: true };
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
    const {
      page,
      limit,
      sortBy,
      sortOrder,
      withCount = true,
      ...filters
    } = query;

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
