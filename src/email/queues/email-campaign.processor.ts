import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { In, Not, Repository } from 'typeorm';
import { EmailCampaign } from '../entities/email-campaign.entity.js';
import { EmailCampaignRecipient } from '../entities/email-campaign-recipient.entity.js';
import { EmailCampaignStatus } from '../enums/email-campaign-status.enum.js';
import { EmailRecipientStatus } from '../enums/email-recipient-status.enum.js';
import { EmailRenderService } from '../services/email-render.service.js';
import { EmailTrackingService } from '../services/email-tracking.service.js';
import { EmailSuppressionService } from '../services/email-suppression.service.js';
import { EmailCampaignsService } from '../services/email-campaigns.service.js';
import {
  MAIL_TRANSPORT,
  type MailTransport,
} from '../transports/mail-transport.interface.js';
import {
  EMAIL_CAMPAIGN_QUEUE,
  EmailCampaignJob,
  type DispatchJobData,
  type SendJobData,
} from './email-queue.constants.js';

/**
 * Sends campaign mail.
 *
 * Concurrency is deliberately one. Marketing mail is not latency-sensitive, and
 * the constraint that actually matters is the receiving side: free relays and
 * personal mailboxes throttle on sustained rate, and every message they refuse
 * counts against the sending reputation. One at a time with an explicit pause
 * between sends is both simpler to reason about than a shared token bucket and
 * correct across multiple server instances, because the queue only ever hands
 * this job to one worker.
 */
@Injectable()
@Processor(EMAIL_CAMPAIGN_QUEUE, { concurrency: 1 })
export class EmailCampaignProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailCampaignProcessor.name);

  /** Jobs enqueued per round trip when fanning out a large campaign. */
  private static readonly FANOUT_CHUNK = 500;

  constructor(
    @InjectRepository(EmailCampaign)
    private readonly campaigns: Repository<EmailCampaign>,
    @InjectRepository(EmailCampaignRecipient)
    private readonly recipients: Repository<EmailCampaignRecipient>,
    @InjectQueue(EMAIL_CAMPAIGN_QUEUE) private readonly queue: Queue,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly render: EmailRenderService,
    private readonly tracking: EmailTrackingService,
    private readonly suppression: EmailSuppressionService,
    private readonly campaignsService: EmailCampaignsService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case EmailCampaignJob.DISPATCH:
        return this.dispatch(job.data as DispatchJobData);
      case EmailCampaignJob.SEND:
        return this.sendOne(job as Job<SendJobData>);
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return null;
    }
  }

  /**
   * Fans a campaign out into one job per recipient.
   *
   * Chunked rather than one `addBulk` of everything: a twenty-thousand entry
   * payload is a multi-megabyte Redis command that blocks the server for
   * everything else while it is parsed, including the OTP queues sharing it.
   */
  private async dispatch({ campaignId }: DispatchJobData): Promise<void> {
    const campaign = await this.campaigns.findOne({ where: { id: campaignId } });
    if (!campaign) {
      this.logger.warn(`Dispatch for missing campaign ${campaignId}`);
      return;
    }

    if (
      campaign.status !== EmailCampaignStatus.QUEUED &&
      campaign.status !== EmailCampaignStatus.SCHEDULED
    ) {
      this.logger.warn(
        `Dispatch skipped: campaign ${campaignId} is ${campaign.status}`,
      );
      return;
    }

    if (!this.transport.isConfigured) {
      await this.failCampaign(
        campaign,
        `Mail transport "${this.transport.name}" is not configured.`,
      );
      return;
    }

    campaign.status = EmailCampaignStatus.SENDING;
    campaign.startedAt = new Date();
    await this.campaigns.save(campaign);

    let queued = 0;
    let lastId: string | null = null;

    for (;;) {
      const qb = this.recipients
        .createQueryBuilder('r')
        .select(['r.id'])
        .where('r.campaignId = :campaignId', { campaignId })
        .andWhere('r.status = :pending', {
          pending: EmailRecipientStatus.PENDING,
        })
        .orderBy('r.id', 'ASC')
        .take(EmailCampaignProcessor.FANOUT_CHUNK);

      if (lastId) qb.andWhere('r.id > :lastId', { lastId });

      const batch = await qb.getMany();
      if (batch.length === 0) break;

      await this.queue.addBulk(
        batch.map((r) => ({
          name: EmailCampaignJob.SEND,
          data: { campaignId, recipientId: r.id } satisfies SendJobData,
          opts: {
            // Keyed on the recipient, so a re-dispatch of a partially sent
            // campaign cannot enqueue a second job for someone already mailed.
            jobId: `send:${r.id}`,
            attempts: 3,
            backoff: { type: 'exponential' as const, delay: 30_000 },
            removeOnComplete: 1_000,
            removeOnFail: false,
          },
        })),
      );

      queued += batch.length;
      lastId = batch[batch.length - 1].id;
    }

    this.logger.log(`Campaign ${campaignId}: ${queued} send jobs enqueued`);

    // An audience that resolved to nobody would otherwise sit at "sending"
    // forever, since completion is detected by a send job finishing.
    if (queued === 0) await this.finaliseIfComplete(campaignId);
  }

  /** Renders and sends to one recipient. */
  private async sendOne(job: Job<SendJobData>): Promise<void> {
    const { campaignId, recipientId } = job.data;

    const campaign = await this.campaigns.findOne({ where: { id: campaignId } });
    if (!campaign) return;

    // Cancelling sets every pending recipient to skipped, but jobs already in
    // Redis still run — so the campaign's own state is checked here too.
    if (
      campaign.status === EmailCampaignStatus.CANCELLED ||
      campaign.status === EmailCampaignStatus.PAUSED
    ) {
      return;
    }

    // Claim the row. The conditional UPDATE is what makes this safe: two
    // workers, or a retry racing a slow first attempt, cannot both pass it.
    const claim = await this.recipients
      .createQueryBuilder()
      .update(EmailCampaignRecipient)
      .set({ status: EmailRecipientStatus.SENDING })
      .where('id = :recipientId AND status = :pending', {
        recipientId,
        pending: EmailRecipientStatus.PENDING,
      })
      .execute();

    const recipient = await this.recipients.findOne({
      where: { id: recipientId },
    });
    if (!recipient) return;

    if (claim.affected === 0) {
      // Not ours to send — unless this is a retry of our own attempt, which
      // left the row in `sending` when it crashed mid-flight.
      const isOwnRetry =
        recipient.status === EmailRecipientStatus.SENDING &&
        recipient.sentAt === null;
      if (!isOwnRetry) return;
    }

    // Re-checked here and not only when the audience was built. A large
    // campaign takes hours to drain, and someone who unsubscribes from the
    // first batch is still sitting in the queue for the rest of it.
    if (await this.suppression.isSuppressed(recipient.email)) {
      await this.markSkipped(recipient, campaign, 'Address is unsubscribed');
      return;
    }

    const remaining = await this.campaignsService.remainingDailyAllowance();
    if (remaining <= 0) {
      // Pausing beats failing: the remaining jobs stay queued and the admin can
      // resume tomorrow, rather than burning three retries each against a quota
      // that will not reopen for hours.
      await this.pauseCampaign(
        campaign,
        'Daily send cap reached. Resume when the window resets.',
      );
      await this.recipients.update(recipient.id, {
        status: EmailRecipientStatus.PENDING,
      });
      return;
    }

    const unsubscribeUrl = this.tracking.unsubscribeUrl(recipient.id);

    const rendered = this.render.render(
      campaign,
      {
        email: recipient.email,
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        companyName: recipient.companyName,
      },
      unsubscribeUrl,
    );

    const html = this.tracking.instrumentHtml(rendered.html, recipient.id, {
      trackOpens: campaign.trackOpens,
      trackClicks: campaign.trackClicks,
    });

    try {
      const outcome = await this.transport.send({
        to: recipient.email,
        toName: [recipient.firstName, recipient.lastName]
          .filter(Boolean)
          .join(' ') || null,
        subject: rendered.subject,
        html,
        text: rendered.text,
        fromName: this.config.get<string>('campaigns.fromName') ?? 'StartMessaging',
        fromEmail: this.config.get<string>('campaigns.fromEmail') ?? '',
        replyTo:
          campaign.replyTo ?? this.config.get<string>('campaigns.replyTo') ?? null,
        unsubscribeUrl,
        campaignId: campaign.id,
        recipientId: recipient.id,
      });

      await this.recipients.update(recipient.id, {
        status: EmailRecipientStatus.SENT,
        sentAt: new Date(),
        providerMessageId: outcome.providerMessageId,
        errorMessage: null,
      });
      await this.campaigns.increment({ id: campaign.id }, 'sentCount', 1);

      await this.pace();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;

      if (isFinalAttempt) {
        await this.recipients.update(recipient.id, {
          status: EmailRecipientStatus.FAILED,
          errorMessage: message,
        });
        await this.campaigns.increment({ id: campaign.id }, 'failedCount', 1);
        this.logger.error(
          `Campaign ${campaignId}: giving up on ${recipient.email}: ${message}`,
        );
        return;
      }

      // Hand the row back so the retry can claim it cleanly.
      await this.recipients.update(recipient.id, {
        status: EmailRecipientStatus.PENDING,
        errorMessage: message,
      });
      throw err;
    } finally {
      await this.finaliseIfComplete(campaignId);
    }
  }

  /**
   * Spaces sends out to the configured rate.
   *
   * A plain sleep rather than BullMQ's limiter because the rate is configured
   * per environment and the `@Processor` decorator's options are fixed at class
   * definition — and because with concurrency 1 this is exactly equivalent.
   */
  private async pace(): Promise<void> {
    const perMinute =
      this.config.get<number>('campaigns.sendRatePerMinute') ?? 12;
    if (perMinute <= 0) return;
    const gap = Math.ceil(60_000 / perMinute);
    await new Promise((resolve) => setTimeout(resolve, gap));
  }

  /** Marks the campaign complete once no recipient is still in flight. */
  private async finaliseIfComplete(campaignId: string): Promise<void> {
    const outstanding = await this.recipients.count({
      where: {
        campaignId,
        status: In([
          EmailRecipientStatus.PENDING,
          EmailRecipientStatus.SENDING,
        ]),
      },
    });
    if (outstanding > 0) return;

    await this.campaigns.update(
      {
        id: campaignId,
        status: EmailCampaignStatus.SENDING,
      },
      { status: EmailCampaignStatus.SENT, completedAt: new Date() },
    );
  }

  private async markSkipped(
    recipient: EmailCampaignRecipient,
    campaign: EmailCampaign,
    reason: string,
  ): Promise<void> {
    await this.recipients.update(recipient.id, {
      status: EmailRecipientStatus.SKIPPED,
      errorMessage: reason,
    });
    await this.campaigns.increment({ id: campaign.id }, 'skippedCount', 1);
  }

  private async pauseCampaign(
    campaign: EmailCampaign,
    reason: string,
  ): Promise<void> {
    // Guarded so the hundreds of jobs that all hit the cap in the same second
    // do not each rewrite the row.
    await this.campaigns.update(
      { id: campaign.id, status: Not(EmailCampaignStatus.PAUSED) },
      { status: EmailCampaignStatus.PAUSED, errorMessage: reason },
    );
    this.logger.warn(`Campaign ${campaign.id} paused: ${reason}`);
  }

  private async failCampaign(
    campaign: EmailCampaign,
    reason: string,
  ): Promise<void> {
    campaign.status = EmailCampaignStatus.FAILED;
    campaign.errorMessage = reason;
    campaign.completedAt = new Date();
    await this.campaigns.save(campaign);
    this.logger.error(`Campaign ${campaign.id} failed: ${reason}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.warn(
      `Job ${job.name}#${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`,
    );
  }
}
