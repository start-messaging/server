import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { User } from '../users/entities/user.entity.js';
import { OnboardingReminder } from './entities/onboarding-reminder.entity.js';
import { OnboardingRemindersService } from './onboarding-reminders.service.js';
import {
  ONBOARDING_REMINDERS_QUEUE,
  OnboardingRemindersProcessor,
} from './queues/onboarding-reminders.processor.js';
import { OnboardingRemindersSchedulerService } from './queues/onboarding-reminders-scheduler.service.js';

/**
 * The "you haven't finished signing up" nudges.
 *
 * Deliberately its own module rather than a corner of UsersModule: it owns a
 * queue, a schedule and a table, and none of that belongs to the user CRUD
 * surface. EmailService needs no import here — CommonModule is @Global.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, OnboardingReminder]),
    BullModule.registerQueue({ name: ONBOARDING_REMINDERS_QUEUE }),
  ],
  providers: [
    OnboardingRemindersService,
    OnboardingRemindersProcessor,
    OnboardingRemindersSchedulerService,
  ],
  exports: [OnboardingRemindersService],
})
export class OnboardingModule {}
