import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';
import { bigintTransformer } from '../../common/database/bigint.transformer.js';

export enum CommissionType {
  /** Commission earned from a referred user's payment. */
  EARN = 'earn',
  /** Balance moved out into a payout request. */
  WITHDRAWAL = 'withdrawal',
  /** A rejected payout returned to the balance. */
  REVERSAL = 'reversal',
  /** Manual admin adjustment. */
  ADJUSTMENT = 'adjustment',
}

/**
 * Append-only commission ledger — one immutable row per earnings movement. The
 * UNIQUE idempotencyKey guarantees a payment credits commission at most once.
 * Deliberately does NOT extend BaseEntity (immutable, no updatedAt/deletedAt).
 */
@Index('uq_commission_ledger_idempotency', ['idempotencyKey'], { unique: true })
@Index('IDX_commission_ledger_partner_createdAt', [
  'partnerUserId',
  'createdAt',
])
@Entity('commission_ledger')
export class CommissionLedger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  partnerUserId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'partnerUserId' })
  partner?: User;

  @Column({ type: 'enum', enum: CommissionType })
  type: CommissionType;

  /** Positive magnitude in integer micros; direction comes from `type`. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: number;

  /** Earnings balance snapshot AFTER applying this row. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  balanceAfter: number;

  @Column({ type: 'uuid', nullable: true })
  referredUserId: string | null;

  /** Source payment (for earn rows). */
  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  /** Related payout request (for withdrawal/reversal rows). */
  @Column({ type: 'uuid', nullable: true })
  payoutId: string | null;

  @Column({ type: 'varchar', length: 200 })
  idempotencyKey: string;

  @Column({ default: '' })
  description: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
