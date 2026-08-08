import {
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity.js';
import { EmailCampaign } from './entities/email-campaign.entity.js';
import { EmailCampaignRecipient } from './entities/email-campaign-recipient.entity.js';
import { EmailEvent } from './entities/email-event.entity.js';
import { EmailSuppression } from './entities/email-suppression.entity.js';
import { EmailAdminController } from './email-admin.controller.js';
import { EmailTrackingController } from './email-tracking.controller.js';
import { EmailCampaignsService } from './services/email-campaigns.service.js';
import { EmailAudienceService } from './services/email-audience.service.js';
import { EmailPreviewService } from './services/email-preview.service.js';
import { EmailRenderService } from './services/email-render.service.js';
import { EmailSuppressionService } from './services/email-suppression.service.js';
import { EmailTrackingService } from './services/email-tracking.service.js';
import { EmailCampaignProcessor } from './queues/email-campaign.processor.js';
import { EMAIL_CAMPAIGN_QUEUE } from './queues/email-queue.constants.js';
import {
  MAIL_TRANSPORT,
  type MailTransport,
} from './transports/mail-transport.interface.js';
import { ConsoleTransport } from './transports/console.transport.js';
import { SmtpTransport } from './transports/smtp.transport.js';
import { BrevoTransport } from './transports/brevo.transport.js';
import { MailgunTransport } from './transports/mailgun.transport.js';

/**
 * Chooses the transport from configuration.
 *
 * Resolved once at boot rather than per send, so a misconfiguration surfaces in
 * the startup log — where someone is looking — instead of as a run of failed
 * jobs an hour into a campaign.
 *
 * An unrecognised value falls back to `console` rather than throwing. Refusing
 * to boot would take the OTP API down over a typo in a marketing setting, which
 * is a far worse outcome than campaigns not sending.
 */
function createMailTransport(config: ConfigService): MailTransport {
  const logger = new Logger('MailTransport');
  const choice = (
    config.get<string>('campaigns.transport') ?? 'console'
  ).toLowerCase();

  switch (choice) {
    case 'smtp':
      return new SmtpTransport({
        host: config.get<string>('campaigns.smtp.host') ?? '',
        port: config.get<number>('campaigns.smtp.port') ?? 587,
        user: config.get<string>('campaigns.smtp.user') ?? '',
        pass: config.get<string>('campaigns.smtp.pass') ?? '',
        secure: config.get<boolean>('campaigns.smtp.secure') ?? false,
        // The queue paces sends already; this is a floor under a
        // misconfiguration, not the primary limit.
        maxPerSecond: Math.max(
          1,
          Math.ceil(
            (config.get<number>('campaigns.sendRatePerMinute') ?? 30) / 60,
          ),
        ),
      });

    case 'brevo':
      return new BrevoTransport(config.get<string>('campaigns.brevo.apiKey'));

    case 'mailgun':
      return new MailgunTransport({
        apiKey: config.get<string>('mailgun.apiKey'),
        domain: config.get<string>('mailgun.domain'),
      });

    case 'console':
      return new ConsoleTransport();

    default:
      logger.warn(
        `Unknown CAMPAIGN_TRANSPORT "${choice}"; campaigns will only be logged.`,
      );
      return new ConsoleTransport();
  }
}

/**
 * Outbound email campaigns: composing, sending, and the analytics behind them.
 *
 * Open, click and unsubscribe tracking are served by this application rather
 * than by the mail provider. That is what lets the transport be a free SMTP
 * relay, a personal mailbox, or an API vendor without the dashboard changing at
 * all — and it means the engagement data belongs to this database rather than
 * to whoever is delivering the mail this quarter.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EmailCampaign,
      EmailCampaignRecipient,
      EmailEvent,
      EmailSuppression,
      User,
    ]),
    BullModule.registerQueue({ name: EMAIL_CAMPAIGN_QUEUE }),
  ],
  controllers: [EmailAdminController, EmailTrackingController],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: createMailTransport,
    },
    EmailCampaignsService,
    EmailAudienceService,
    EmailPreviewService,
    EmailRenderService,
    EmailSuppressionService,
    EmailTrackingService,
    EmailCampaignProcessor,
  ],
  exports: [EmailCampaignsService, EmailSuppressionService],
})
export class EmailModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailModule.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  onModuleInit(): void {
    this.logger.log(
      `Campaign transport: ${this.transport.name} ` +
        `(configured=${this.transport.isConfigured})`,
    );
  }

  /**
   * Drains the SMTP pool on shutdown.
   *
   * Without it a rolling deploy leaves the relay holding half-open
   * authenticated connections, and providers that cap concurrent connections
   * start refusing the new instance while the old one's sockets time out.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.transport instanceof SmtpTransport) {
      await this.transport.close();
    }
  }
}
