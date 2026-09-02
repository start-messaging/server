/** One outreach email, fully rendered, ready for a transport. */
export interface OutreachMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra RFC headers — List-Unsubscribe and friends. */
  headers: Record<string, string>;
}

/**
 * A transport that can deliver one cold email.
 *
 * An interface rather than a union so the console provider and any future
 * real transport are interchangeable at the injection site — the orchestrator
 * decides which one is live, the send path never branches on it.
 */
export interface OutreachProvider {
  readonly name: string;
  send(msg: OutreachMessage): Promise<{ ref: string }>;
}
