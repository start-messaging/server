import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ONBOARDING_REMINDERS_QUEUE,
  OnboardingReminderJob,
} from './onboarding-reminders.processor.js';

/** Stable scheduler id, so re-registering replaces rather than duplicates. */
const SWEEP_SCHEDULER = 'onboarding-reminders-sweep';

@Injectable()
export class OnboardingRemindersSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(
    OnboardingRemindersSchedulerService.name,
  );

  constructor(
    @InjectQueue(ONBOARDING_REMINDERS_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether this process should own the repeatable sweep.
   *
   * Unlike the affiliate scheduler, which defaults *on*, this one defaults
   * *off* and has to be switched on deliberately. The asymmetry is the blast
   * radius: the affiliate jobs move numbers in our own ledger, where a wrong
   * run is repairable and invisible to customers. This one sends mail to real
   * people, and `server/.env` points at the production database — so a
   * developer running the API locally against it would otherwise start
   * emailing live customers on boot, with no way to recall it.
   *
   * It also keeps CI quiet: the e2e suite boots the full application, and a
   * sweep firing mid-test is both a race and an outbound send.
   */
  private get schedulingEnabled(): boolean {
    return this.config.get<boolean>('onboardingReminders.enabled') === true;
  }

  onModuleInit(): void {
    if (!this.schedulingEnabled) {
      this.logger.log(
        'ONBOARDING_REMINDERS_ENABLED is not true — the reminder sweep is not scheduled.',
      );
      // Not scheduling is not the same as unscheduling. The scheduler is
      // persisted in Redis, so an environment that ever ran with the flag on
      // keeps producing hourly sweeps after it is turned off — which is how a
      // kill switch that reads as "off" everywhere still sent mail. The
      // processor refuses those jobs now, but leaving them to be produced and
      // discarded every hour is noise standing where a real signal belongs.
      void this.removeStaleSchedule();
      return;
    }

    // Retried in the background rather than awaited once, matching the
    // affiliate scheduler: a single Redis blip during a rolling deploy must
    // not leave the process running for days with no schedule registered.
    void this.syncWithRetry();
  }

  /**
   * Drops a schedule left behind by a run that had the flag on.
   *
   * Best-effort and never fatal: Redis being away at boot must not stop the
   * API coming up, and the processor's own gate is what actually guarantees no
   * mail leaves. Removing an id that is not there is a no-op.
   */
  private async removeStaleSchedule(): Promise<void> {
    try {
      const removed = await this.queue.removeJobScheduler(SWEEP_SCHEDULER);
      if (removed) {
        this.logger.warn(
          'Removed an onboarding reminder schedule left over from a run with ' +
            'ONBOARDING_REMINDERS_ENABLED=true. No further sweeps will be produced.',
        );
      }
    } catch (err) {
      this.logger.error(
        `Could not remove the stale onboarding reminder schedule: ${(err as Error).message}`,
      );
    }
  }

  private async syncWithRetry(): Promise<void> {
    const delaysMs = [1_000, 5_000, 15_000, 60_000, 300_000];

    for (let attempt = 0; ; attempt++) {
      if (await this.syncSchedule()) {
        if (attempt > 0) {
          this.logger.log(
            `Onboarding reminder schedule registered after ${attempt + 1} attempts.`,
          );
        }
        return;
      }

      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      this.logger.warn(
        `Onboarding reminder schedule registration failed; retrying in ${delay / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async syncSchedule(): Promise<boolean> {
    if (!this.schedulingEnabled) return true;

    try {
      // Hourly, but only between 09:00 and 20:00 India time.
      //
      // The hours are in the cron expression rather than in a quiet-hours
      // check inside the sweep, because expressing it here means there is only
      // one place to read to know when mail can leave. Both reminder windows
      // are 24 hours wide, so holding an account that becomes eligible at
      // 02:00 until the 09:00 run still delivers it comfortably inside its
      // window — it just arrives at an hour a person might actually read it.
      //
      // `tz` is explicit for the same reason the payout schedule carries one:
      // without it BullMQ resolves the pattern in the process's local
      // timezone, and "09:00" on a UTC container is 14:30 IST.
      await this.queue.upsertJobScheduler(
        SWEEP_SCHEDULER,
        { pattern: '0 9-20 * * *', tz: 'Asia/Kolkata' },
        {
          name: OnboardingReminderJob.SWEEP,
          opts: { removeOnComplete: 50, removeOnFail: 100 },
        },
      );

      this.logger.log(
        'Onboarding reminder sweep scheduled hourly, 09:00-20:00 Asia/Kolkata.',
      );
      return true;
    } catch (err) {
      // Never fatal: the API must still come up if Redis is briefly away.
      this.logger.error(
        `Could not register the onboarding reminder schedule: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
