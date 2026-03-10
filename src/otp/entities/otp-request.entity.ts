import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

export enum OtpStatus {
  PENDING = 'pending',
  SENT = 'sent',
}

@Index('IDX_otp_requests_userId_status_createdAt', [
  'userId',
  'status',
  'createdAt',
])
@Entity('otp_requests')
export class OtpRequest extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  phoneNumber: string;

  @Column({ type: 'enum', enum: OtpStatus, default: OtpStatus.PENDING })
  status: OtpStatus;
}
