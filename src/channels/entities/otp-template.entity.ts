import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { Channel } from './channel.entity.js';
import { TemplateStatus } from '../enums/template-status.enum.js';

@Entity('otp_templates')
export class OtpTemplate extends BaseEntity {
  @Column()
  name: string;

  @Column()
  body: string;

  @Column()
  channelId: string;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channelId' })
  channel: Channel;

  @Column({
    type: 'varchar',
    default: TemplateStatus.DRAFT,
  })
  status: TemplateStatus;

  @Column({ type: 'varchar', nullable: true })
  language: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}
