import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  MailTransport,
  OutboundMessage,
  SendOutcome,
} from './mail-transport.interface.js';

/**
 * Logs campaign mail instead of sending it.
 *
 * The default transport, on purpose. A developer running the stack locally
 * against a copy of production data is one "Send" click away from cold-emailing
 * every real customer in that dump; making the safe option the one you get by
 * doing nothing is the only version of this that survives contact with a
 * hurried afternoon.
 *
 * It mirrors the SMS side, which has the same `SMS_CONSOLE_PROVIDER` escape
 * hatch for the same reason.
 */
export class ConsoleTransport implements MailTransport {
  readonly name = 'console';
  readonly isConfigured = true;

  private readonly logger = new Logger(ConsoleTransport.name);

  send(message: OutboundMessage): Promise<SendOutcome> {
    this.logger.log(
      `[console-mail] to=${message.to} subject="${message.subject}" ` +
        `campaign=${message.campaignId} recipient=${message.recipientId}`,
    );
    // Logged at debug so a local run can inspect the rendered body — including
    // that the tracking pixel and unsubscribe link actually made it in —
    // without drowning the normal log at info.
    this.logger.debug(`[console-mail] unsubscribe=${message.unsubscribeUrl}`);
    this.logger.debug(`[console-mail] html=\n${message.html}`);

    return Promise.resolve({ providerMessageId: `console-${randomUUID()}` });
  }
}
