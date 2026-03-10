import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Index('IDX_api_keys_userId_isActive', ['userId', 'isActive'])
@Index('IDX_api_keys_keyHash', ['keyHash'])
@Entity('api_keys')
export class ApiKey extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ length: 12 })
  keyPrefix: string;

  @Column()
  keyHash: string;

  @Column({ default: '' })
  label: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'text', array: true, nullable: true, default: null })
  allowedIps: string[] | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;
}
