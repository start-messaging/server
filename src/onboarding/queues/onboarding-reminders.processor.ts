import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { OnboardingRemindersService } from '../onboarding-reminders.service.js';

export const ONBOARDING_REMINDERS_QUEUE = 'onboarding-reminders';

export const OnboardingReminderJob = {
  SWEEP: 'sweep',
} as const;

/**
 * Runs the onboarding reminder sweep.
 *
 * On a queue rather than an in-process timer for the same reason the affiliate
 * jobs are: a `@Cron` in a multi-instance deployment fires on every instance
 * at once. Here that would mean the same customer receiving the same nudge
 * once per running process. The queue guarantees the scheduled job reaches
 * exactly one worker, and the unique constraint in the database catches the
 * case the queue cannot — two sweeps overlapping because one ran long.
 */
@Processor(ONBOARDING_REMINDERS_QUEUE)
export class OnboardingRemindersProcessor extends WorkerHost {
  private readonly logger = new Logger(OnboardingRemindersProcessor.name);

  constructor(
    private readonly reminders: OnboardingRemindersService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== OnboardingReminderJob.SWEEP) {
      this.logger.warn(`Ignoring unknown job "${job.name}".`);
      return null;
    }

    // The gate is checked here, at fire time, and not only where the schedule
    // is registered.
    //
    // A BullMQ job scheduler lives in Redis, not in this process. So once
    // ONBOARDING_REMINDERS_ENABLED had been true even once against a given
    // Redis, turning it back to false only stopped the schedule being
    // *re-registered* — the scheduler already stored there kept producing
    // hourly sweeps, and this worker is registered unconditionally by
    // OnboardingModule and kept sending them. The one switch that exists to
    // stop mail reaching real customers did not stop it.
    //
    // Same shape as the leads pipeline, where every schedule is always
    // registered and each sweep reads its gate when it fires.
    if (this.config.get<boolean>('onboardingReminders.enabled') !== true) {
      this.logger.warn(
        'Skipping the reminder sweep: ONBOARDING_REMINDERS_ENABLED is not true. ' +
          'A schedule registered by an earlier run is still producing jobs — ' +
          'remove it with the queue scheduler id "onboarding-reminders-sweep" ' +
          'if this environment should not be sending at all.',
      );
      return null;
    }

    const results = await this.reminders.run();

    for (const r of results) {
      // Only speak up when the sweep actually did something. This fires every
      // hour; logging "0 sent" twelve times a day buries the runs that matter.
      if (r.eligible === 0) continue;

      this.logger.log(
        `${r.stage}: ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped ` +
          `of ${r.eligible} eligible`,
      );

      if (r.capped) {
        this.logger.warn(
          `${r.stage}: more accounts were eligible than the per-run cap allowed. ` +
            `The remainder are still inside their window and will be picked up ` +
            `by the next sweep — but if this repeats, raise ` +
            `REMINDERS_MAX_PER_RUN (src/onboarding/constants/` +
            `onboarding-reminders.constant.ts) or the backlog will age out unsent.`,
        );
      }
    }

    return results;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(
      `Onboarding reminder sweep failed (job ${job?.id}): ${err.message}`,
    );
  }
}
