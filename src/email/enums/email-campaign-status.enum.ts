/**
 * Lifecycle of an outbound campaign.
 *
 * `SENDING` and `SENT` describe what this server handed to Mailgun, not what
 * landed in an inbox — delivery is decided minutes later by webhooks, and is
 * tracked per recipient. A campaign reaching `SENT` therefore only means every
 * recipient job has run, which is why the panel shows delivered/bounced counts
 * separately rather than treating `SENT` as success.
 */
export enum EmailCampaignStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  QUEUED = 'queued',
  SENDING = 'sending',
  SENT = 'sent',
  PAUSED = 'paused',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

/** Statuses whose campaigns may still be edited. */
export const EDITABLE_CAMPAIGN_STATUSES: readonly EmailCampaignStatus[] = [
  EmailCampaignStatus.DRAFT,
  EmailCampaignStatus.SCHEDULED,
  EmailCampaignStatus.PAUSED,
];
