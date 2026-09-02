import { Injectable, Logger } from '@nestjs/common';
import {
  OutreachMessage,
  OutreachProvider,
} from './outreach-provider.interface.js';

/**
 * Logs the outreach email instead of sending it. Local development and tests
 * only — the same idiom as the console SMS provider, and just as dangerous in
 * production, where a send would silently succeed without reaching anyone.
 */
@Injectable()
export class ConsoleOutreachProvider implements OutreachProvider {
  readonly name = 'console';

  private readonly logger = new Logger(ConsoleOutreachProvider.name);

  send(msg: OutreachMessage): Promise<{ ref: string }> {
    this.logger.log(`[console outreach] to=${msg.to} subject="${msg.subject}"`);
    return Promise.resolve({ ref: 'console' });
  }
}
