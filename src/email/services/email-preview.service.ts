import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity.js';
import {
  EmailRenderService,
  MERGE_FIELDS,
  type MergeContext,
  type RenderedEmail,
} from './email-render.service.js';
import { EmailTrackingService } from './email-tracking.service.js';
import {
  MAIL_TRANSPORT,
  type MailTransport,
} from '../transports/mail-transport.interface.js';
import type { PreviewRenderDto } from '../dto/campaign.dto.js';

/**
 * Renders a campaign for the composer, and sends single test copies.
 *
 * Split from `EmailCampaignsService` so the campaign lifecycle does not have to
 * know about the transport at all — the only two things that send are this and
 * the queue worker, and keeping both away from the CRUD logic is what stops a
 * stray call from mailing anyone during an ordinary save.
 */
@Injectable()
export class EmailPreviewService {
  private readonly logger = new Logger(EmailPreviewService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly render: EmailRenderService,
    private readonly tracking: EmailTrackingService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Renders exactly what one person would receive.
   *
   * `previewFor` looks the address up among real customers so the admin can
   * check the merge fields against a live record — the failure this catches is
   * a `{{companyName}}` that is blank for most of the list, which sample data
   * would never reveal.
   */
  async preview(dto: PreviewRenderDto): Promise<
    RenderedEmail & {
      context: MergeContext;
      isSampleData: boolean;
    }
  > {
    let context = this.render.sampleContext();
    let isSampleData = true;

    if (dto.previewFor) {
      const user = await this.users
        .createQueryBuilder('u')
        .where('LOWER(u.email) = LOWER(:email)', { email: dto.previewFor })
        .getOne();

      if (user) {
        context = {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          companyName: user.companyName,
        };
        isSampleData = false;
      } else {
        context = { email: dto.previewFor };
        isSampleData = false;
      }
    }

    // A preview must show the real unsubscribe footer, but pointing it at a
    // real recipient id would let a preview click actually unsubscribe someone.
    const rendered = this.render.render(
      {
        subject: dto.subject,
        bodyHtml: dto.bodyHtml,
        preheader: dto.preheader ?? null,
      },
      context,
      this.tracking.unsubscribeUrl('00000000-0000-0000-0000-000000000000'),
    );

    return { ...rendered, context, isSampleData };
  }

  /**
   * Sends one test copy.
   *
   * Untracked on purpose: the admin opening their own test would otherwise
   * register as an open before the campaign has been sent to anyone, and the
   * first number on the analytics screen would be wrong from the start.
   */
  async sendTest(
    campaign: { subject: string; bodyHtml: string; preheader?: string | null; replyTo?: string | null },
    to: string,
  ): Promise<void> {
    if (!this.transport.isConfigured) {
      throw new BadRequestException(
        `Mail transport "${this.transport.name}" is not configured. Set the CAMPAIGN_* environment variables first.`,
      );
    }

    const context: MergeContext = {
      ...this.render.sampleContext(),
      email: to,
    };

    const unsubscribeUrl = this.tracking.unsubscribeUrl(
      '00000000-0000-0000-0000-000000000000',
    );

    const rendered = this.render.render(
      {
        subject: `[TEST] ${campaign.subject}`,
        bodyHtml: campaign.bodyHtml,
        preheader: campaign.preheader ?? null,
      },
      context,
      unsubscribeUrl,
    );

    await this.transport.send({
      to,
      toName: null,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      fromName: this.config.get<string>('campaigns.fromName') ?? 'StartMessaging',
      fromEmail: this.config.get<string>('campaigns.fromEmail') ?? '',
      replyTo:
        campaign.replyTo ?? this.config.get<string>('campaigns.replyTo') ?? null,
      unsubscribeUrl,
      campaignId: 'test',
      recipientId: 'test',
    });

    this.logger.log(`Test copy sent to ${to} via ${this.transport.name}`);
  }

  /** What the composer needs to know about how sending is set up. */
  transportStatus(): {
    name: string;
    isConfigured: boolean;
    trackingConfigured: boolean;
    fromEmail: string | null;
    dailySendCap: number;
    sendRatePerMinute: number;
    mergeFields: typeof MERGE_FIELDS;
  } {
    return {
      name: this.transport.name,
      isConfigured: this.transport.isConfigured,
      trackingConfigured: this.tracking.isConfigured,
      fromEmail: this.config.get<string>('campaigns.fromEmail') ?? null,
      dailySendCap: this.config.get<number>('campaigns.dailySendCap') ?? 250,
      sendRatePerMinute:
        this.config.get<number>('campaigns.sendRatePerMinute') ?? 30,
      mergeFields: MERGE_FIELDS,
    };
  }
}
