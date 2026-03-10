import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';

@Entity('channels')
export class Channel extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column()
  displayName: string;

  @Column({ default: true })
  isActive: boolean;
}
