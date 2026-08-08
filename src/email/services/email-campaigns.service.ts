import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, MoreThan, Repository } from 'typeorm';
import {
  EmailAudienceType,
  EmailCampaign,
} from '../entities/email-campaign.entity.js';
import { EmailCampaignRecipient } from '../entities/email-campaign-recipient.entity.js';
import { EmailEvent, EmailEventType } from '../entities/email-event.entity.js';
import {
  EDITABLE_CAMPAIGN_STATUSES,
  EmailCampaignStatus,
} from '../enums/email-campaign-status.enum.js';
import {
  EmailRecipientStatus,
  FUNNEL_RANK,
} from '../enums/email-recipient-status.enum.js';
import { EmailSuppressionReason } from '../enums/email-suppression-reason.enum.js';
import {
  EmailAudienceService,
  MAX_AUDIENCE_SIZE,
  type AudienceContact,
} from './email-audience.service.js';
import { EmailSuppressionService } from './email-suppression.service.js';
import {
  EMAIL_CAMPAIGN_QUEUE,
  EmailCampaignJob,
} from '../queues/email-queue.constants.js';
import type {
  AudienceDto,
  ManualRecipientDto,
} from '../dto/audience.dto.js';
import type {
  CampaignQueryDto,
  CreateCampaignDto,
  RecipientQueryDto,
  UpdateCampaignDto,
} from '../dto/campaign.dto.js';

/** Fields the analytics screen shows above the recipient table. */
export interface CampaignStats {
  funnel: {
    total: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
    failed: number;
    skipped: number;
  };
  rates: {
    /** Denominator is `sent`, not `total` — skipped addresses never had a chance. */
    openRate: number;
    clickRate: number;
    /** Clicks over opens: how compelling the mail was to those who read it. */
    clickToOpenRate: number;
    bounceRate: number;
    unsubscribeRate: number;
  };
  /** Engagement by hour for the first day, then by day. */
  timeline: { bucket: string; opened: number; clicked: number }[];
  topLinks: { url: string; clicks: number; uniqueClicks: number }[];
  clients: { name: string; count: number }[];
  devices: { name: string; count: number }[];
}

@Injectable()
export class EmailCampaignsService {
  private readonly logger = new Logger(EmailCampaignsService.name);

  /** Rows materialised per round trip when building a large audience. */
  private static readonly MATERIALISE_BATCH = 500;

  constructor(
    @InjectRepository(EmailCampaign)
    private readonly campaigns: Repository<EmailCampaign>,
    @InjectRepository(EmailCampaignRecipient)
    private readonly recipients: Repository<EmailCampaignRecipient>,
    @InjectRepository(EmailEvent)
    private readonly events: Repository<EmailEvent>,
    @InjectQueue(EMAIL_CAMPAIGN_QUEUE)
    private readonly queue: Queue,
    private readonly audience: EmailAudienceService,
    private readonly suppression: EmailSuppressionService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  // ── CRUD ─────────────────────────────────────────────

  async create(
    dto: CreateCampaignDto,
    adminId: string | null,
  ): Promise<EmailCampaign> {
    const campaign = this.campaigns.create({
      name: dto.name,
      subject: dto.subject,
      bodyHtml: dto.bodyHtml,
      preheader: dto.preheader ?? null,
      replyTo: dto.replyTo ?? null,
      trackOpens: dto.trackOpens ?? true,
      trackClicks: dto.trackClicks ?? true,
      audienceType: dto.audience?.type ?? EmailAudienceType.SEGMENT,
      audienceFilter: dto.audience?.filter ?? null,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      status: EmailCampaignStatus.DRAFT,
      createdBy: adminId,
    });

    const saved = await this.campaigns.save(campaign);

    // Manual addresses are persisted immediately rather than at send time. They
    // exist only in the request that carried them — a draft that dropped them
    // would silently become an empty campaign when the admin came back to it.
    if (dto.audience) {
      await this.storeManualRecipients(saved.id, dto.audience);
    }

    return saved;
  }

  async update(id: string, dto: UpdateCampaignDto): Promise<EmailCampaign> {
    const campaign = await this.getOrFail(id);
    this.assertEditable(campaign);

    Object.assign(campaign, {
      name: dto.name ?? campaign.name,
      subject: dto.subject ?? campaign.subject,
      bodyHtml: dto.bodyHtml ?? campaign.bodyHtml,
      preheader: dto.preheader === undefined ? campaign.preheader : dto.preheader,
      replyTo: dto.replyTo === undefined ? campaign.replyTo : dto.replyTo,
      trackOpens: dto.trackOpens ?? campaign.trackOpens,
      trackClicks: dto.trackClicks ?? campaign.trackClicks,
      scheduledAt: dto.scheduledAt
        ? new Date(dto.scheduledAt)
        : campaign.scheduledAt,
    });

    if (dto.audience) {
      campaign.audienceType = dto.audience.type ?? campaign.audienceType;
      campaign.audienceFilter =
        dto.audience.filter ?? campaign.audienceFilter;
      await this.storeManualRecipients(campaign.id, dto.audience);
    }

    return this.campaigns.save(campaign);
  }

  async list(query: CampaignQueryDto): Promise<[EmailCampaign[], number]> {
    const qb = this.campaigns.createQueryBuilder('c');

    if (query.status) qb.andWhere('c.status = :status', { status: query.status });
    if (query.search) {
      qb.andWhere('(c.name ILIKE :q OR c.subject ILIKE :q)', {
        q: `%${query.search.trim()}%`,
      });
    }

    const sortColumn = {
      created_at: 'c.createdAt',
      updated_at: 'c.updatedAt',
      name: 'c.name',
      status: 'c.status',
      sent: 'c.sentCount',
      opened: 'c.openedCount',
    }[query.sortBy ?? 'created_at'];

    return qb
      .orderBy(sortColumn, query.sortOrder ?? 'DESC')
      .skip(query.offset)
      .take(query.limit)
      .getManyAndCount();
  }

  async getOrFail(id: string): Promise<EmailCampaign> {
    const campaign = await this.campaigns.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async remove(id: string): Promise<void> {
    const campaign = await this.getOrFail(id);
    // A sent campaign is a record of what was mailed to whom. Deleting it would
    // leave the events and suppressions it produced pointing at nothing, and
    // there is no way to un-send it, so there is nothing to undo.
    if (campaign.status === EmailCampaignStatus.SENDING) {
      throw new BadRequestException(
        'Cancel the campaign before deleting it.',
      );
    }
    await this.campaigns.softDelete(id);
  }

  // ── Audience ─────────────────────────────────────────

  /**
   * Sizes an audience without saving anything.
   *
   * Segment and manual counts are reported separately as well as combined,
   * because "412 customers + 6 pasted" is the number the admin can sanity-check
   * against what they intended; a single total hides a filter that matched
   * nothing while the paste happened to work.
   */
  async previewAudience(dto: AudienceDto): Promise<{
    total: number;
    segmentCount: number;
    manualCount: number;
    suppressedCount: number;
    sample: AudienceContact[];
  }> {
    const contacts = await this.resolveManualContacts(dto);
    const manualEmails = new Set(contacts.map((c) => c.email));

    const segmentCount = dto.filter
      ? await this.audience.countSegment(dto.filter)
      : 0;

    const sample = dto.filter
      ? await this.audience.previewSegment(dto.filter, 8)
      : contacts.slice(0, 8);

    // The segment query already excludes suppressed addresses; only the pasted
    // list still needs checking, and those are the ones worth reporting since
    // the admin chose them explicitly and deserves to know some were dropped.
    const suppressed = await this.suppression.findSuppressed([...manualEmails]);

    return {
      segmentCount,
      manualCount: manualEmails.size - suppressed.size,
      suppressedCount: suppressed.size,
      total: segmentCount + (manualEmails.size - suppressed.size),
      sample,
    };
  }

  // ── Sending ──────────────────────────────────────────

  /**
   * Materialises recipients and hands the campaign to the queue.
   *
   * Recipients are written before anything is enqueued so the campaign has a
   * complete, inspectable list the instant it starts — and so a crash between
   * the two leaves a campaign that can be re-sent, rather than half a mail-out
   * with no record of who already received it.
   */
  async send(id: string, adminId: string | null): Promise<EmailCampaign> {
    const campaign = await this.getOrFail(id);

    if (!EDITABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new BadRequestException(
        `Campaign is ${campaign.status} and cannot be sent again.`,
      );
    }
    if (!campaign.bodyHtml?.trim()) {
      throw new BadRequestException('Campaign has no body.');
    }
    if (!campaign.subject?.trim()) {
      throw new BadRequestException('Campaign has no subject.');
    }

    const materialised = await this.materialiseRecipients(campaign);
    if (materialised === 0) {
      throw new BadRequestException(
        'This audience resolves to nobody. Check the filter, or that every address is not already unsubscribed.',
      );
    }

    const remaining = await this.remainingDailyAllowance();
    if (materialised > remaining) {
      this.logger.warn(
        `Campaign ${id} needs ${materialised} sends but only ${remaining} remain in today's cap.`,
      );
    }

    campaign.status = EmailCampaignStatus.QUEUED;
    campaign.totalRecipients = materialised;
    campaign.errorMessage = null;
    campaign.startedAt = null;
    campaign.completedAt = null;
    await this.campaigns.save(campaign);

    const delay = campaign.scheduledAt
      ? Math.max(0, campaign.scheduledAt.getTime() - Date.now())
      : 0;

    await this.queue.add(
      EmailCampaignJob.DISPATCH,
      { campaignId: campaign.id },
      {
        // Keyed on the campaign so a double-click on Send cannot enqueue two
        // dispatchers and mail the whole list twice.
        jobId: `dispatch:${campaign.id}`,
        delay,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Campaign ${id} queued by ${adminId ?? 'system'}: ${materialised} recipients, delay ${delay}ms`,
    );

    return campaign;
  }

  /**
   * Stops a campaign that has not finished.
   *
   * Already-sent messages cannot be recalled, so this only prevents the
   * remaining ones: pending recipients are marked skipped and their queued jobs
   * become no-ops when they find a non-pending row.
   */
  async cancel(id: string): Promise<EmailCampaign> {
    const campaign = await this.getOrFail(id);

    if (
      campaign.status !== EmailCampaignStatus.QUEUED &&
      campaign.status !== EmailCampaignStatus.SENDING &&
      campaign.status !== EmailCampaignStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        `Campaign is ${campaign.status} and is not running.`,
      );
    }

    await this.queue.remove(`dispatch:${campaign.id}`).catch(() => undefined);

    const { affected } = await this.recipients
      .createQueryBuilder()
      .update(EmailCampaignRecipient)
      .set({
        status: EmailRecipientStatus.SKIPPED,
        errorMessage: 'Campaign cancelled before this message was sent',
      })
      .where('campaignId = :id AND status = :pending', {
        id: campaign.id,
        pending: EmailRecipientStatus.PENDING,
      })
      .execute();

    campaign.status = EmailCampaignStatus.CANCELLED;
    campaign.completedAt = new Date();
    campaign.skippedCount += affected ?? 0;

    this.logger.log(`Campaign ${id} cancelled; ${affected ?? 0} unsent`);

    return this.campaigns.save(campaign);
  }

  /**
   * Builds the recipient rows.
   *
   * Idempotent through a unique index on (campaignId, email): re-running after
   * a partial failure tops the list up rather than duplicating it, which is
   * what makes a failed send safe to retry.
   */
  private async materialiseRecipients(
    campaign: EmailCampaign,
  ): Promise<number> {
    let written = 0;

    const insert = async (contacts: AudienceContact[]) => {
      if (contacts.length === 0) return;

      const rows = contacts.map((c) => ({
        campaignId: campaign.id,
        userId: c.userId,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        companyName: c.companyName,
        status: EmailRecipientStatus.PENDING,
      }));

      const result = await this.recipients
        .createQueryBuilder()
        .insert()
        .into(EmailCampaignRecipient)
        .values(rows)
        // The same person can match the segment filter *and* appear in the
        // pasted list. Without this they would get two copies of a cold email,
        // which is the fastest route to a spam complaint.
        .orIgnore()
        .execute();

      written += result.identifiers.filter(Boolean).length;
    };

    if (campaign.audienceFilter) {
      await this.audience.eachSegmentBatch(
        campaign.audienceFilter,
        EmailCampaignsService.MATERIALISE_BATCH,
        insert,
      );
    }

    // Manual rows were stored as recipients when the draft was saved, so they
    // are already present and counted below.
    const total = await this.recipients.count({
      where: {
        campaignId: campaign.id,
        status: EmailRecipientStatus.PENDING,
      },
    });

    if (total > MAX_AUDIENCE_SIZE) {
      throw new BadRequestException(
        `Audience of ${total} exceeds the ${MAX_AUDIENCE_SIZE} ceiling for one campaign.`,
      );
    }

    this.logger.log(
      `Campaign ${campaign.id}: materialised ${written} new, ${total} pending`,
    );

    return total;
  }

  /**
   * Persists hand-entered addresses onto the draft.
   *
   * Suppressed addresses are dropped here rather than at send time so the
   * admin sees the real number in the composer, and so nobody has to explain
   * later why the campaign reached fewer people than it said it would.
   */
  private async storeManualRecipients(
    campaignId: string,
    dto: AudienceDto,
  ): Promise<void> {
    const contacts = await this.resolveManualContacts(dto);
    if (contacts.length === 0) return;

    const suppressed = await this.suppression.findSuppressed(
      contacts.map((c) => c.email),
    );
    const allowed = contacts.filter((c) => !suppressed.has(c.email));
    if (allowed.length === 0) return;

    await this.recipients
      .createQueryBuilder()
      .insert()
      .into(EmailCampaignRecipient)
      .values(
        allowed.map((c) => ({
          campaignId,
          userId: c.userId,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          companyName: c.companyName,
          status: EmailRecipientStatus.PENDING,
        })),
      )
      .orIgnore()
      .execute();
  }

  /** Merges the structured and pasted halves of a manual audience. */
  private async resolveManualContacts(
    dto: AudienceDto,
  ): Promise<AudienceContact[]> {
    const fromStructured: AudienceContact[] = (dto.manual ?? []).map(
      (m: ManualRecipientDto) => ({
        userId: null,
        email: m.email.trim().toLowerCase(),
        firstName: m.firstName ?? null,
        lastName: m.lastName ?? null,
        companyName: m.companyName ?? null,
      }),
    );

    const fromRaw = dto.manualRaw
      ? this.audience.parseManualRecipients(dto.manualRaw)
      : [];

    const merged = new Map<string, AudienceContact>();
    [...fromStructured, ...fromRaw].forEach((c) => {
      if (c.email) merged.set(c.email, merged.get(c.email) ?? c);
    });

    return this.audience.enrichFromUsers([...merged.values()]);
  }

  /**
   * How many sends are left under the rolling daily cap.
   *
   * Counted across every campaign, because the cap protects a shared resource —
   * one sending account's reputation and free-tier quota — not any single
   * campaign's budget.
   */
  async remainingDailyAllowance(): Promise<number> {
    const cap = this.config.get<number>('campaigns.dailySendCap') ?? 250;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const used = await this.recipients.count({
      where: { sentAt: MoreThan(since) },
    });

    return Math.max(0, cap - used);
  }

  // ── Recipients & analytics ───────────────────────────

  async listRecipients(
    campaignId: string,
    query: RecipientQueryDto,
  ): Promise<[EmailCampaignRecipient[], number]> {
    const qb = this.recipients
      .createQueryBuilder('r')
      .where('r.campaignId = :campaignId', { campaignId });

    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.openedOnly) qb.andWhere('r.openCount > 0');
    if (query.search) {
      qb.andWhere(
        '(r.email ILIKE :q OR r.firstName ILIKE :q OR r.lastName ILIKE :q OR r.companyName ILIKE :q)',
        { q: `%${query.search.trim()}%` },
      );
    }

    return qb
      // Most-engaged first: the whole point of the screen is finding who to
      // follow up with, and that is never the people at the top alphabetically.
      .orderBy('r.clickCount', 'DESC')
      .addOrderBy('r.openCount', 'DESC')
      .addOrderBy('r.email', 'ASC')
      .skip(query.offset)
      .take(query.limit)
      .getManyAndCount();
  }

  /**
   * Every campaign one customer has been sent.
   *
   * Powers the outreach history on the customer detail screen, which is there
   * to stop the most avoidable mistake in outbound sales: mailing somebody a
   * fourth cold pitch while they have an open support ticket.
   */
  async listRecipientsForUser(
    userId: string,
    query: { page: number; limit: number; offset: number },
  ): Promise<[EmailCampaignRecipient[], number]> {
    return this.recipients
      .createQueryBuilder('r')
      .innerJoinAndMapOne(
        'r.campaign',
        EmailCampaign,
        'c',
        'c.id = r.campaignId',
      )
      .where('r.userId = :userId', { userId })
      .orderBy('r.createdAt', 'DESC')
      .skip(query.offset)
      .take(query.limit)
      .getManyAndCount();
  }

  async getStats(campaignId: string): Promise<CampaignStats> {
    const c = await this.getOrFail(campaignId);

    const pct = (numerator: number, denominator: number) =>
      denominator > 0
        ? Math.round((numerator / denominator) * 1000) / 10
        : 0;

    const [timeline, topLinks, clients, devices] = await Promise.all([
      this.engagementTimeline(campaignId),
      this.topLinks(campaignId),
      this.breakdown(campaignId, 'clientName'),
      this.breakdown(campaignId, 'deviceType'),
    ]);

    return {
      funnel: {
        total: c.totalRecipients,
        sent: c.sentCount,
        delivered: c.deliveredCount,
        opened: c.openedCount,
        clicked: c.clickedCount,
        bounced: c.bouncedCount,
        complained: c.complainedCount,
        unsubscribed: c.unsubscribedCount,
        failed: c.failedCount,
        skipped: c.skippedCount,
      },
      rates: {
        openRate: pct(c.openedCount, c.sentCount),
        clickRate: pct(c.clickedCount, c.sentCount),
        clickToOpenRate: pct(c.clickedCount, c.openedCount),
        bounceRate: pct(c.bouncedCount, c.sentCount),
        unsubscribeRate: pct(c.unsubscribedCount, c.sentCount),
      },
      timeline,
      topLinks,
      clients,
      devices,
    };
  }

  /**
   * Opens and clicks bucketed by hour.
   *
   * Hourly rather than daily because cold outreach is judged on send time —
   * "Tuesday 10am beat Friday 4pm" is the actionable finding, and a daily
   * bucket erases exactly that.
   */
  private async engagementTimeline(
    campaignId: string,
  ): Promise<{ bucket: string; opened: number; clicked: number }[]> {
    const rows = await this.events
      .createQueryBuilder('e')
      .select("date_trunc('hour', e.occurredAt)", 'bucket')
      .addSelect(
        `COUNT(*) FILTER (WHERE e.event = '${EmailEventType.OPENED}')`,
        'opened',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE e.event = '${EmailEventType.CLICKED}')`,
        'clicked',
      )
      .where('e.campaignId = :campaignId', { campaignId })
      .andWhere('e.event IN (:...types)', {
        types: [EmailEventType.OPENED, EmailEventType.CLICKED],
      })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC')
      .limit(24 * 14)
      .getRawMany<{ bucket: Date; opened: string; clicked: string }>();

    return rows.map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      opened: Number(r.opened),
      clicked: Number(r.clicked),
    }));
  }

  private async topLinks(
    campaignId: string,
  ): Promise<{ url: string; clicks: number; uniqueClicks: number }[]> {
    const rows = await this.events
      .createQueryBuilder('e')
      .select('e.url', 'url')
      .addSelect('COUNT(*)', 'clicks')
      .addSelect('COUNT(DISTINCT e.recipientId)', 'uniqueClicks')
      .where('e.campaignId = :campaignId', { campaignId })
      .andWhere('e.event = :event', { event: EmailEventType.CLICKED })
      .andWhere('e.url IS NOT NULL')
      .groupBy('e.url')
      .orderBy('clicks', 'DESC')
      .limit(10)
      .getRawMany<{ url: string; clicks: string; uniqueClicks: string }>();

    return rows.map((r) => ({
      url: r.url,
      clicks: Number(r.clicks),
      uniqueClicks: Number(r.uniqueClicks),
    }));
  }

  private async breakdown(
    campaignId: string,
    column: 'clientName' | 'deviceType',
  ): Promise<{ name: string; count: number }[]> {
    const rows = await this.events
      .createQueryBuilder('e')
      .select(`e.${column}`, 'name')
      .addSelect('COUNT(DISTINCT e.recipientId)', 'count')
      .where('e.campaignId = :campaignId', { campaignId })
      .andWhere(`e.${column} IS NOT NULL`)
      .groupBy(`e.${column}`)
      .orderBy('count', 'DESC')
      .limit(8)
      .getRawMany<{ name: string; count: string }>();

    return rows.map((r) => ({ name: r.name, count: Number(r.count) }));
  }

  // ── Event ingestion ──────────────────────────────────

  /**
   * Records one thing that happened to one recipient.
   *
   * The single entry point for the tracking endpoints and any provider webhook,
   * so the funnel-advance rules and the counter arithmetic exist once. Runs in a
   * transaction because the event insert, the recipient update and the campaign
   * counter must agree — a crash between them would leave a dashboard that
   * disagrees with its own recipient table, and nothing would ever correct it.
   */
  async recordEvent(input: {
    recipientId: string;
    event: EmailEventType;
    occurredAt?: Date;
    url?: string | null;
    reason?: string | null;
    ip?: string | null;
    userAgentMeta?: {
      clientName?: string | null;
      deviceType?: string | null;
    } | null;
    providerEventId?: string | null;
    providerMessageId?: string | null;
    raw?: Record<string, any> | null;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const recipientRepo = manager.getRepository(EmailCampaignRecipient);
      const campaignRepo = manager.getRepository(EmailCampaign);
      const eventRepo = manager.getRepository(EmailEvent);

      const recipient = await recipientRepo.findOne({
        where: { id: input.recipientId },
      });
      if (!recipient) {
        this.logger.warn(
          `Event ${input.event} for unknown recipient ${input.recipientId}`,
        );
        return;
      }

      // A provider redelivering the same event must not double-count it.
      if (input.providerEventId) {
        const seen = await eventRepo.count({
          where: { providerEventId: input.providerEventId },
        });
        if (seen > 0) return;
      }

      const occurredAt = input.occurredAt ?? new Date();

      await eventRepo.insert({
        campaignId: recipient.campaignId,
        recipientId: recipient.id,
        email: recipient.email,
        event: input.event,
        url: input.url ?? null,
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        clientName: input.userAgentMeta?.clientName ?? null,
        deviceType: input.userAgentMeta?.deviceType ?? null,
        providerEventId: input.providerEventId ?? null,
        providerMessageId:
          input.providerMessageId ?? recipient.providerMessageId ?? null,
        occurredAt,
        raw: input.raw ?? null,
      });

      const campaignPatch: Record<string, number> = {};
      const recipientPatch: Partial<EmailCampaignRecipient> = {};

      switch (input.event) {
        case EmailEventType.DELIVERED:
          if (!recipient.deliveredAt) {
            recipientPatch.deliveredAt = occurredAt;
            campaignPatch.deliveredCount = 1;
          }
          break;

        case EmailEventType.OPENED:
          recipientPatch.openCount = recipient.openCount + 1;
          recipientPatch.lastOpenedAt = occurredAt;
          // The campaign counter is *unique* openers, so it moves only on the
          // first open. Total opens live on the recipient row.
          if (!recipient.firstOpenedAt) {
            recipientPatch.firstOpenedAt = occurredAt;
            campaignPatch.openedCount = 1;
          }
          break;

        case EmailEventType.CLICKED:
          recipientPatch.clickCount = recipient.clickCount + 1;
          if (!recipient.firstClickedAt) {
            recipientPatch.firstClickedAt = occurredAt;
            campaignPatch.clickedCount = 1;
          }
          break;

        case EmailEventType.BOUNCED:
          if (recipient.status !== EmailRecipientStatus.BOUNCED) {
            campaignPatch.bouncedCount = 1;
          }
          recipientPatch.errorMessage = input.reason ?? 'Bounced';
          break;

        case EmailEventType.COMPLAINED:
          if (recipient.status !== EmailRecipientStatus.COMPLAINED) {
            campaignPatch.complainedCount = 1;
          }
          break;

        case EmailEventType.UNSUBSCRIBED:
          if (recipient.status !== EmailRecipientStatus.UNSUBSCRIBED) {
            campaignPatch.unsubscribedCount = 1;
          }
          break;

        default:
          break;
      }

      const nextStatus = this.statusForEvent(input.event);
      if (nextStatus && FUNNEL_RANK[nextStatus] > FUNNEL_RANK[recipient.status]) {
        recipientPatch.status = nextStatus;
      }

      if (Object.keys(recipientPatch).length > 0) {
        await recipientRepo.update(recipient.id, recipientPatch);
      }

      // Incremented in SQL rather than read-modify-written: a popular campaign
      // has many events landing at once, and `campaign.openedCount + 1` in JS
      // loses every increment but the last.
      for (const [column, delta] of Object.entries(campaignPatch)) {
        await campaignRepo.increment({ id: recipient.campaignId }, column, delta);
      }
    });

    // Opting out is a fact about the address, not about this campaign, so it is
    // recorded outside the transaction above and against the global list.
    if (
      input.event === EmailEventType.UNSUBSCRIBED ||
      input.event === EmailEventType.COMPLAINED ||
      input.event === EmailEventType.BOUNCED
    ) {
      await this.suppressFromEvent(input.recipientId, input.event);
    }
  }

  private async suppressFromEvent(
    recipientId: string,
    event: EmailEventType,
  ): Promise<void> {
    const recipient = await this.recipients.findOne({
      where: { id: recipientId },
    });
    if (!recipient) return;

    const reason =
      event === EmailEventType.COMPLAINED
        ? EmailSuppressionReason.COMPLAINED
        : event === EmailEventType.BOUNCED
          ? EmailSuppressionReason.BOUNCED
          : EmailSuppressionReason.UNSUBSCRIBED;

    await this.suppression.suppress(recipient.email, reason, {
      campaignId: recipient.campaignId,
    });
  }

  private statusForEvent(
    event: EmailEventType,
  ): EmailRecipientStatus | null {
    switch (event) {
      case EmailEventType.ACCEPTED:
        return EmailRecipientStatus.SENT;
      case EmailEventType.DELIVERED:
        return EmailRecipientStatus.DELIVERED;
      case EmailEventType.OPENED:
        return EmailRecipientStatus.OPENED;
      case EmailEventType.CLICKED:
        return EmailRecipientStatus.CLICKED;
      case EmailEventType.BOUNCED:
        return EmailRecipientStatus.BOUNCED;
      case EmailEventType.COMPLAINED:
        return EmailRecipientStatus.COMPLAINED;
      case EmailEventType.UNSUBSCRIBED:
        return EmailRecipientStatus.UNSUBSCRIBED;
      case EmailEventType.FAILED:
        return EmailRecipientStatus.FAILED;
      default:
        return null;
    }
  }

  private assertEditable(campaign: EmailCampaign): void {
    if (!EDITABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new BadRequestException(
        `A ${campaign.status} campaign cannot be edited. Duplicate it instead.`,
      );
    }
  }
}
