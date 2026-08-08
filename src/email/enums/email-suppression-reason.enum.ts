/** Why an address must never receive another campaign. */
export enum EmailSuppressionReason {
  UNSUBSCRIBED = 'unsubscribed',
  COMPLAINED = 'complained',
  /** Hard bounce — the mailbox does not exist. */
  BOUNCED = 'bounced',
  /** Added by an admin, e.g. after someone asked over the phone. */
  MANUAL = 'manual',
}
