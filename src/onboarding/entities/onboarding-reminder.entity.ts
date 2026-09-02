import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';
import {
  OnboardingReminderStage,
  OnboardingReminderStatus,
} from '../enums/onboarding-reminder.enum.js';

/**
 * One row per reminder we have decided to send to one account.
 *
 * The row is written *before* the email goes out, not after. That ordering is
 * the whole point of the table: the sweep runs hourly and several instances
 * may run it at once, so "have we already nudged this person?" has to be
 * answered by something that can refuse a second writer. A unique constraint
 * on (userId, stage) does that; a check-then-send in application code does
 * not, and the failure mode there is emailing a customer the same reminder
 * twelve times in a day.
 *
 * The cost of writing first is that a process killed mid-send leaves a
 * `pending` row and that reminder is never sent. That is the right way round —
 * a missed nudge is invisible, a duplicate one is a complaint.
 */
@Entity('onboarding_reminders')
@Unique('UQ_onboarding_reminders_user_stage', ['userId', 'stage'])
export class OnboardingReminder extends BaseEntity {
  @Index('IDX_onboarding_reminders_userId')
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: OnboardingReminderStage })
  stage: OnboardingReminderStage;

  @Column({
    type: 'enum',
    enum: OnboardingReminderStatus,
    default: OnboardingReminderStatus.PENDING,
  })
  status: OnboardingReminderStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /**
   * Which step the account was actually stuck on when we sent.
   *
   * Kept because the copy is chosen from it: without it, a bounce or a
   * complaint cannot be traced back to the wording the customer received.
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  blockedStep: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}
