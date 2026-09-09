/**
 * Which of the two nudges a row represents.
 *
 * Named for the day they land on rather than "first"/"second", because the
 * copy differs per stage and a numbered name stops meaning anything the moment
 * a third one is added between them.
 */
export enum OnboardingReminderStage {
  /** The 24-48 hour nudge. */
  DAY_2 = 'day_2',
  /** The 7-8 day nudge — the last one we ever send. */
  DAY_7 = 'day_7',
}

/**
 * The thing the customer still has to do. Drives the copy and the CTA.
 *
 * Lives beside the stage rather than next to the sweep that computes it, so
 * EmailService can type its parameters against it without importing the
 * service that imports EmailService.
 */
export enum OnboardingBlockedStep {
  MOBILE_VERIFICATION = 'mobile_verification',
  KYC_SUBMISSION = 'kyc_submission',
  KYC_RESUBMISSION = 'kyc_resubmission',
}

/** Outcome of an attempt, one row per user per stage. */
export enum OnboardingReminderStatus {
  /** Claimed by a sweep; the send has not resolved yet. */
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

/**
 * How old an account must be, in hours, to receive each stage.
 *
 * Each window is exactly 24 hours wide while the sweep runs hourly through
 * business hours, so an eligible account meets a dozen runs before it ages
 * out. That redundancy is the point: a missed run — a deploy, a Redis blip, a
 * restart — costs a few hours rather than the whole reminder. The unique
 * constraint on (userId, stage) is what makes the repetition safe.
 */
export const ONBOARDING_REMINDER_WINDOWS: Record<
  OnboardingReminderStage,
  { fromHours: number; toHours: number }
> = {
  [OnboardingReminderStage.DAY_2]: { fromHours: 24, toHours: 48 },
  [OnboardingReminderStage.DAY_7]: { fromHours: 24 * 7, toHours: 24 * 8 },
};

/** Swept in this order, youngest account age first. */
export const ONBOARDING_REMINDER_STAGES: readonly OnboardingReminderStage[] = [
  OnboardingReminderStage.DAY_2,
  OnboardingReminderStage.DAY_7,
];

/**
 * How many times a failed send is retried before the row is left alone.
 *
 * Bounded because the alternative is an address that hard-bounces being
 * retried on every sweep for as long as the account sits in its window.
 */
export const ONBOARDING_REMINDER_MAX_ATTEMPTS = 3;
