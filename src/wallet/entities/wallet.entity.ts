import { Column, Entity, JoinColumn, OneToOne, VersionColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('wallets')
export class Wallet extends BaseEntity {
  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  balance: number;

  @Column({ default: 'INR' })
  currency: string;

  @VersionColumn()
  version: number;
}
