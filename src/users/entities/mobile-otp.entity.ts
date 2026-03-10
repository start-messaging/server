import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';

@Entity('mobile_otps')
@Index(['userId', 'createdAt'])
export class MobileOtp extends BaseEntity {
  @Column('uuid')
  userId: string;

  @Column()
  phoneNumber: string;

  @Column({ type: 'varchar', select: false })
  otpHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ default: false })
  verified: boolean;
}
