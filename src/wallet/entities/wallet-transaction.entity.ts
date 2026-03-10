import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Wallet } from './wallet.entity.js';

export enum WalletTransactionType {
  CREDIT = 'credit',
  DEBIT = 'debit',
  REFUND = 'refund',
}

@Index('IDX_wallet_tx_walletId_type_createdAt', [
  'walletId',
  'type',
  'createdAt',
])
@Entity('wallet_transactions')
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  walletId: string;

  @ManyToOne(() => Wallet)
  @JoinColumn({ name: 'walletId' })
  wallet: Wallet;

  @Column({ type: 'enum', enum: WalletTransactionType })
  type: WalletTransactionType;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  amount: number;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  balanceBefore: number;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  balanceAfter: number;

  @Column({ type: 'varchar', nullable: true })
  referenceType: string | null;

  @Column({ type: 'varchar', nullable: true })
  referenceId: string | null;

  @Column({ default: '' })
  description: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
