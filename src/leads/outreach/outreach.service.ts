import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
// randomUUID from crypto, not the `uuid` package: `uuid` is ESM-only and
// breaks any jest suite that reaches this file — see
// correlation-id.middleware.ts for the incident.
import { randomUUID } from 'crypto';

import { ErrorCodes } from '../../common/constants/error-codes.constant.js';
import { PostHogService } from '../../common/services/posthog.service.js';
import { Lead } from '../entities/lead.entity.js';
import { LeadOutreachEvent } from '../entities/lead-outreach-event.entity.js';
import { OutreachSuppression } from '../entities/outreach-suppression.entity.js';
import {
  LeadOutreachEventType,
  LeadStatus,
  SuppressionReason,
} from '../enums/lead.enum.js';
import { QueueOutreachDto } from '../dto/queue-outreach.dto.js';
import { OutreachProvider } from './outreach-provider.interface.js';
import { SmtpOutreachProvider } from './smtp-outreach.provider.js';
import { ConsoleOutreachProvider } from './console-outreach.provider.js';
import { buildOutreachEmail } from './outreach-email.template.js';
import { APP_NAME } from '../../common/constants/app.constants.js';

/** Provider name recorded on first-party pixel/click/unsubscribe events. */
const TRACKER = 'tracker';

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    @InjectRepository(Lead)
    private readonly leads: Repository<Lead>,
    @InjectRepository(LeadOutreachEvent)
    private readonly events: Repository<LeadOutreachEvent>,
    @InjectRepository(OutreachSuppression)
    private readonly suppressions: Repository<OutreachSuppression>,
    private readonly config: ConfigService,
    private readonly smtpProvider: SmtpOutreachProvider,
    private readonly consoleProvider: ConsoleOutreachProvider,
    private readonly posthog: PostHogService,
  ) {}

  /** SMTP when fully configured; console when explicitly enabled; else 503. */
  resolveProvider(): OutreachProvider {
    const smtpReady =
      !!this.config.get<string>('outreach.smtp.host') &&
      !!this.config.get<string>('outreach.smtp.user') &&
      !!this.config.get<string>('outreach.smtp.pass') &&
      !!this.config.get<string>('outreach.fromEmail');
    if (smtpReady) return this.smtpProvider;

    if (this.config.get<boolean>('outreach.consoleProvider') === true) {
      return this.consoleProvider;
    }

    throw new ServiceUnavailableException({
      code: ErrorCodes.OUTREACH_NOT_CONFIGURED,
      message:
        'No outreach transport is configured in this environment. Set the OUTREACH_SMTP_* variables (or OUTREACH_CONSOLE_PROVIDER for local runs).',
    });
  }

  /** Emails sent since the start of today, where "today" is an IST day. */
  async dailySentCount(): Promise<number> {
    const todayIst = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const startOfIstDay = new Date(`${todayIst}T00:00:00+05:30`);
    return this.events.count({
      where: {
        type: LeadOutreachEventType.SENT,
        occurredAt: MoreThanOrEqual(startOfIstDay),
      },
    });
  }

  /**
   * Queues and immediately sends one outreach email.
   *
   * The claim happens BEFORE the send, in a single UPDATE whose WHERE is the
   * arbiter — the same claim-before-send shape as the onboarding reminders.
   * Two admins clicking at once both pass the status check above; only one
   * UPDATE matches `status = 'new'`, and the loser gets the same 409 it would
   * have gotten arriving a second later.
   */
  async queueOutreach(leadId: string, dto: QueueOutreachDto): Promise<Lead> {
    const lead = await this.leads.findOne({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lead not found',
      });
    }

    if (lead.status !== LeadStatus.NEW) {
      throw new ConflictException({
        code: ErrorCodes.LEAD_ALREADY_QUEUED,
        message: `Lead is '${lead.status}', not 'new' — outreach has already been queued or resolved.`,
      });
    }

    const email = dto.email.toLowerCase();

    const suppressed = await this.suppressions.findOne({ where: { email } });
    if (suppressed) {
      throw new ConflictException({
        code: ErrorCodes.LEAD_SUPPRESSED,
        message: `${email} is on the suppression list (${suppressed.reason}) and cannot be contacted.`,
      });
    }

    const provider = this.resolveProvider();

    const cap = this.config.get<number>('outreach.dailyCap') ?? 100;
    if ((await this.dailySentCount()) >= cap) {
      throw new HttpException(
        {
          code: ErrorCodes.OUTREACH_DAILY_CAP_REACHED,
          message: `The daily outreach cap of ${cap} has been reached. It resets at midnight IST; raise OUTREACH_DAILY_CAP only alongside domain warmup.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // COALESCE keeps an existing token: a lead re-queued after a revert must
    // keep the token its earlier (possibly delivered) email already carries.
    // TypeORM returns UPDATE ... RETURNING as [rows, affectedCount].
    const claimed: [Array<{ id: string }>, number] = await this.leads.query(
      `UPDATE leads
          SET status = 'queued',
              "queuedAt" = now(),
              "outreachEmail" = $2,
              "outreachToken" = COALESCE("outreachToken", $3),
              "updatedAt" = now()
        WHERE id = $1 AND status = 'new'
       RETURNING id`,
      [leadId, email, randomUUID()],
    );
    if (!claimed[0] || claimed[0].length === 0) {
      throw new ConflictException({
        code: ErrorCodes.LEAD_ALREADY_QUEUED,
        message: 'Another request queued this lead first.',
      });
    }

    const queued = (await this.leads.findOne({ where: { id: leadId } }))!;

    await this.recordEvent(leadId, LeadOutreachEventType.QUEUED, provider.name, {
      email,
    });

    const trackingBaseUrl =
      this.config.get<string>('outreach.publicBaseUrl') ??
      'https://api.startmessaging.com';
    const rendered = buildOutreachEmail({
      lead: queued,
      trackingBaseUrl,
      linkBaseUrl:
        this.config.get<string>('outreach.linkBaseUrl') ??
        'https://startmessaging.com',
      fromName: this.config.get<string>('outreach.fromName') ?? APP_NAME,
      postalAddress: this.config.get<string>('outreach.postalAddress') ?? '',
      subjectOverride: dto.subject,
      bodyHtmlOverride: dto.bodyHtml,
    });

    try {
      const { ref } = await provider.send({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: {
          // RFC 8058 one-click unsubscribe: Gmail and Yahoo require these on
          // bulk mail, and honouring them is what keeps complaint rates down.
          'List-Unsubscribe': `<${trackingBaseUrl}/t/u/${queued.outreachToken}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      await this.leads.update(leadId, {
        status: LeadStatus.CONTACTED,
        contactedAt: new Date(),
        outreachProviderRef: ref,
      });
      await this.recordEvent(leadId, LeadOutreachEventType.SENT, provider.name, {
        email,
        ref,
      });
      this.posthog.capture({
        distinctId: `lead_${queued.id}`,
        event: 'outreach_email_sent',
        properties: { domain: queued.domain, email },
      });
    } catch (err) {
      const message = (err as Error).message ?? 'unknown provider error';
      await this.recordEvent(
        leadId,
        LeadOutreachEventType.FAILED,
        provider.name,
        { message },
      );
      // Revert the claim but keep the token: nothing left this machine, so
      // the lead goes back to 'new' for a retry once the transport is fixed.
      await this.leads.update(leadId, {
        status: LeadStatus.NEW,
        queuedAt: null,
      });
      throw new HttpException(
        {
          code: ErrorCodes.OUTREACH_PROVIDER_ERROR,
          message: `The outreach transport rejected the send: ${message}`,
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return (await this.leads.findOne({ where: { id: leadId } }))!;
  }

  /**
   * Records an open. Unknown token → null, silently: a tracking URL must
   * never be an oracle that confirms which tokens exist.
   *
   * First open only. Apple MPP and Gmail's image proxy prefetch pixels, so
   * repeat fetches carry no signal worth a row — openedAt answers "did the
   * mail land somewhere that rendered it", nothing more.
   */
  async handleOpen(token: string): Promise<Lead | null> {
    const lead = await this.leads.findOne({ where: { outreachToken: token } });
    if (!lead) return null;

    if (!lead.openedAt) {
      await this.leads.update(lead.id, { openedAt: new Date() });
      await this.recordEvent(lead.id, LeadOutreachEventType.OPENED, TRACKER);
      this.posthog.capture({
        distinctId: `lead_${lead.id}`,
        event: 'outreach_email_opened',
        properties: { domain: lead.domain },
      });
    }
    return lead;
  }

  /** Records a click. Every click gets an event; clickedAt keeps the first. */
  async handleClick(token: string, url: string): Promise<Lead | null> {
    const lead = await this.leads.findOne({ where: { outreachToken: token } });
    if (!lead) return null;

    if (!lead.clickedAt) {
      await this.leads.update(lead.id, { clickedAt: new Date() });
    }
    await this.recordEvent(lead.id, LeadOutreachEventType.CLICKED, TRACKER, {
      url,
    });
    this.posthog.capture({
      distinctId: `lead_${lead.id}`,
      event: 'outreach_email_clicked',
      properties: { domain: lead.domain, url },
    });
    return lead;
  }

  /** Unsubscribes the lead and suppresses the address permanently. */
  async handleUnsubscribe(token: string): Promise<Lead | null> {
    const lead = await this.leads.findOne({ where: { outreachToken: token } });
    if (!lead) return null;

    // A converted lead is a customer now; their transactional relationship
    // is not this pipeline's to revoke. The suppression still lands below, so
    // outreach specifically never mails them again.
    if (lead.status !== LeadStatus.CONVERTED) {
      await this.leads.update(lead.id, { status: LeadStatus.UNSUBSCRIBED });
    }

    await this.recordEvent(lead.id, LeadOutreachEventType.UNSUBSCRIBED, TRACKER);

    if (lead.outreachEmail) {
      // ON CONFLICT DO NOTHING: mail clients re-fire unsubscribe links, and
      // the second click must not error or overwrite a stronger reason.
      await this.suppressions.query(
        `INSERT INTO outreach_suppressions (email, reason)
         VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING`,
        [lead.outreachEmail.toLowerCase(), SuppressionReason.UNSUBSCRIBED],
      );
    }

    this.posthog.capture({
      distinctId: `lead_${lead.id}`,
      event: 'outreach_unsubscribed',
      properties: { domain: lead.domain },
    });
    return lead;
  }

  private async recordEvent(
    leadId: string,
    type: LeadOutreachEventType,
    provider: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.events.save(
      this.events.create({
        leadId,
        type,
        provider,
        payload: payload ?? null,
        occurredAt: new Date(),
      }),
    );
  }
}
