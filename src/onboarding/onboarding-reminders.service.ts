import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../users/entities/user.entity.js';
import { UserRole } from '../users/enums/user-role.enum.js';
import { KycStatus } from '../users/enums/kyc-status.enum.js';
import { EmailService } from '../common/services/email.service.js';
import { OnboardingReminder } from './entities/onboarding-reminder.entity.js';
import {
  ONBOARDING_REMINDER_MAX_ATTEMPTS,
  ONBOARDING_REMINDER_STAGES,
  ONBOARDING_REMINDER_WINDOWS,
  OnboardingBlockedStep,
  OnboardingReminderStage,
  OnboardingReminderStatus,
} from './enums/onboarding-reminder.enum.js';
import { REMINDERS_MAX_PER_RUN } from './constants/onboarding-reminders.constant.js';

/** What one sweep did, per stage. Returned so the processor can log it. */
export interface OnboardingReminderRunResult {
  stage: OnboardingReminderStage;
  eligible: number;
  sent: number;
  failed: number;
  skipped: number;
  capped: boolean;
}

@Injectable()
export class OnboardingRemindersService {
  private readonly logger = new Logger(OnboardingRemindersService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(OnboardingReminder)
    private readonly reminders: Repository<OnboardingReminder>,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private get dryRun(): boolean {
    return this.config.get<boolean>('onboardingReminders.dryRun') === true;
  }

  private get maxPerRun(): number {
    return REMINDERS_MAX_PER_RUN;
  }

  /** Sweeps every stage. The entry point the queue calls. */
  async run(): Promise<OnboardingReminderRunResult[]> {
    const results: OnboardingReminderRunResult[] = [];
    for (const stage of ONBOARDING_REMINDER_STAGES) {
      results.push(await this.runStage(stage));
    }
    return results;
  }

  async runStage(
    stage: OnboardingReminderStage,
  ): Promise<OnboardingReminderRunResult> {
    const cap = this.maxPerRun;

    // One extra row is fetched purely to detect that the cap bound, so the log
    // can say so. A cap that silently truncates reads as "everyone was
    // covered" when it wasn't.
    const candidates = await this.findEligible(stage, cap + 1);
    const capped = candidates.length > cap;
    const batch = capped ? candidates.slice(0, cap) : candidates;

    const result: OnboardingReminderRunResult = {
      stage,
      eligible: batch.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      capped,
    };

    for (const user of batch) {
      const step = blockedStepFor(user);

      // Should not happen — the query filters on the same condition — but a
      // user who finishes onboarding between the SELECT and here would
      // otherwise be emailed "you haven't finished".
      if (!step) {
        result.skipped++;
        continue;
      }

      // Before the claim, not after it. A dry run used to claim the row and
      // then mark it SENT, which was the one thing a rehearsal must never do:
      // the (userId, stage) row IS the "already reminded" record, findEligible
      // excludes anyone who has a non-failed one, and there are only ever two
      // stages per account. So previewing a run permanently cancelled the real
      // reminder for every account it previewed — turn DRY_RUN off afterwards
      // and those customers never hear from us at all. Claiming nothing leaves
      // eligibility exactly as the sweep found it, which is what makes this
      // safe to run against production before flipping ENABLED for real.
      if (this.dryRun) {
        this.logger.log(
          `[dry-run] would send ${stage} reminder to ${user.email} (stuck at ${step})`,
        );
        result.sent++;
        continue;
      }

      const reminderId = await this.claim(user.id, stage, step);
      if (!reminderId) {
        // Another instance got there first, or the retry budget is spent.
        result.skipped++;
        continue;
      }

      try {
        const ok = await this.email.sendOnboardingReminderEmail(
          user.email,
          displayNameFor(user),
          stage,
          step,
        );

        if (ok) {
          await this.reminders.update(reminderId, {
            status: OnboardingReminderStatus.SENT,
            sentAt: new Date(),
            lastError: null,
          });
          result.sent++;
        } else {
          // sendEmail returns false rather than throwing when Mailgun rejects
          // or is unconfigured, so a falsy return is a real failure, not a
          // no-op to be counted as success.
          await this.reminders.update(reminderId, {
            status: OnboardingReminderStatus.FAILED,
            lastError: 'transport reported failure',
          });
          result.failed++;
        }
      } catch (err) {
        await this.reminders.update(reminderId, {
          status: OnboardingReminderStatus.FAILED,
          lastError: (err as Error).message?.slice(0, 1000) ?? 'unknown error',
        });
        result.failed++;
      }
    }

    return result;
  }

  /**
   * Accounts of the right age that still have something of their own to do.
   *
   * The condition deliberately is *not* `hasCompletedOnboarding = false`.
   * That flag only flips when an admin approves KYC, so an account that has
   * submitted everything and is waiting on our review still reads as
   * incomplete — and telling that customer to "finish signing up" when the
   * ball is on our side of the net is worse than saying nothing at all.
   */
  private findEligible(
    stage: OnboardingReminderStage,
    limit: number,
  ): Promise<User[]> {
    const { fromHours, toHours } = ONBOARDING_REMINDER_WINDOWS[stage];
    const now = Date.now();
    const newest = new Date(now - fromHours * 60 * 60 * 1000);
    const oldest = new Date(now - toHours * 60 * 60 * 1000);

    return this.users
      .createQueryBuilder('u')
      .where('u.role = :role', { role: UserRole.CUSTOMER })
      .andWhere('u.isActive = true')
      .andWhere("u.email IS NOT NULL AND u.email <> ''")
      .andWhere('u.hasCompletedOnboarding = false')
      .andWhere(
        '(u.mobileVerified = false OR u.kycStatus IN (:...pendingOnCustomer))',
        {
          pendingOnCustomer: [KycStatus.NOT_SUBMITTED, KycStatus.REJECTED],
        },
      )
      .andWhere('u.createdAt <= :newest', { newest })
      .andWhere('u.createdAt > :oldest', { oldest })
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM onboarding_reminders r
            WHERE r."userId" = u.id
              AND r.stage = :stage::onboarding_reminders_stage_enum
              AND (r.status <> 'failed' OR r.attempts >= :maxAttempts)
         )`,
        { stage, maxAttempts: ONBOARDING_REMINDER_MAX_ATTEMPTS },
      )
      .orderBy('u.createdAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Takes ownership of one (user, stage) before anything is sent.
   *
   * Returns the row id if this caller won it, or null if somebody else already
   * holds it or the retry budget is spent. The whole decision is one statement
   * so two instances sweeping at the same moment cannot both win: the second
   * INSERT hits the unique constraint, falls into DO UPDATE, and its WHERE
   * rejects the row because the status is `pending` rather than `failed`.
   */
  private async claim(
    userId: string,
    stage: OnboardingReminderStage,
    blockedStep: OnboardingBlockedStep,
  ): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.reminders.query(
      `INSERT INTO onboarding_reminders
         ("userId", "stage", "status", "attempts", "blockedStep")
       VALUES ($1, $2::onboarding_reminders_stage_enum, 'pending', 1, $3)
       ON CONFLICT ("userId", "stage") DO UPDATE
          SET "attempts"    = onboarding_reminders."attempts" + 1,
              "status"      = 'pending',
              "blockedStep" = EXCLUDED."blockedStep",
              "updatedAt"   = now()
        WHERE onboarding_reminders."status" = 'failed'
          AND onboarding_reminders."attempts" < $4
       RETURNING "id"`,
      [userId, stage, blockedStep, ONBOARDING_REMINDER_MAX_ATTEMPTS],
    );

    return rows[0]?.id ?? null;
  }
}

/**
 * What the customer still owes us, or null if nothing.
 *
 * Mirrors the ladder in OnboardingGuard, and stops at KYC submission on
 * purpose: `PENDING` means we are reviewing, and there is nothing to nudge.
 */
export function blockedStepFor(user: User): OnboardingBlockedStep | null {
  if (!user.mobileVerified) return OnboardingBlockedStep.MOBILE_VERIFICATION;
  if (user.kycStatus === KycStatus.NOT_SUBMITTED) {
    return OnboardingBlockedStep.KYC_SUBMISSION;
  }
  if (user.kycStatus === KycStatus.REJECTED) {
    return OnboardingBlockedStep.KYC_RESUBMISSION;
  }
  return null;
}

/** Best human-readable name we hold, falling back to the local part. */
export function displayNameFor(user: User): string {
  const candidates = [
    user.businessName,
    user.companyName,
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
  ];
  const name = candidates.find((c) => c && c.trim().length > 0);
  return name?.trim() || user.email.split('@')[0];
}
