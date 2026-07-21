import { Column, Entity, JoinColumn, OneToOne, VersionColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { bigintTransformer } from '../../common/database/bigint.transformer.js';

@Entity('wallets')
export class Wallet extends BaseEntity {
  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  /** Available balance in integer micros (1 unit = 1,000,000 micros). */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  balance: number;

  @Column({ default: 'INR' })
  currency: string;

  @VersionColumn()
  version: number;
}
