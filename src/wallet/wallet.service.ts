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
    return this.dataSource.transaction('SERIALIZABLE', async (txManager) => {
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
    return this.dataSource.transaction('SERIALIZABLE', async (txManager) => {
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
    const wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.userId = :userId', { userId })
      .getOne();

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
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
    const wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.userId = :userId', { userId })
      .getOne();

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
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
  ): Promise<[WalletTransaction[], number]> {
    const wallet = await this.getWallet(userId);
    return this.transactionRepository.findAndCount({
      where: {
        walletId: wallet.id,
        type: In([WalletTransactionType.CREDIT, WalletTransactionType.REFUND]),
      },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }
}
