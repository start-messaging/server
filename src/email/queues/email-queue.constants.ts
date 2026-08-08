/**
 * Queue and job names for campaign sending.
 *
 * In their own module so the service that enqueues and the processor that
 * consumes can share them without importing each other — which they otherwise
 * would, in both directions.
 */
export const EMAIL_CAMPAIGN_QUEUE = 'email-campaign';

export const EmailCampaignJob = {
  /** Materialises the audience, then fans out one SEND job per recipient. */
  DISPATCH: 'dispatch',
  /** Sends to exactly one recipient. */
  SEND: 'send',
} as const;

export interface DispatchJobData {
  campaignId: string;
}

export interface SendJobData {
  campaignId: string;
  recipientId: string;
}
