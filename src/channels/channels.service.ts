import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, IsNull, Repository } from 'typeorm';
import { Channel } from './entities/channel.entity.js';
import { OtpTemplate } from './entities/otp-template.entity.js';
import { TemplateStatus } from './enums/template-status.enum.js';

const SYSTEM_TEMPLATES = [
  {
    name: 'Standard OTP',
    body: 'Your OTP is {{otp}}. Do not share this code with anyone. Powered by Start Messaging',
  },
];

/** Statuses a customer may still edit / resubmit. */
const EDITABLE_STATUSES: TemplateStatus[] = [
  TemplateStatus.DRAFT,
  TemplateStatus.REJECTED,
];

@Injectable()
export class ChannelsService implements OnModuleInit {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    @InjectRepository(OtpTemplate)
    private readonly templateRepository: Repository<OtpTemplate>,
  ) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  private async seedDefaults() {
    let smsChannel = await this.channelRepository.findOne({
      where: { name: 'sms' },
    });

    if (!smsChannel) {
      smsChannel = await this.channelRepository.save(
        this.channelRepository.create({
          name: 'sms',
          displayName: 'SMS',
          isActive: true,
        }),
      );
      this.logger.log('Seeded SMS channel');
    }

    // Seed the shared SYSTEM templates (userId = null) if none exist.
    const templateCount = await this.templateRepository.count({
      where: { channelId: smsChannel.id, userId: IsNull() },
    });

    if (templateCount === 0) {
      const templates = SYSTEM_TEMPLATES.map((t) =>
        this.templateRepository.create({
          ...t,
          userId: null,
          channelId: smsChannel.id,
          status: TemplateStatus.APPROVED,
          language: 'en',
        }),
      );
      await this.templateRepository.save(templates);
      this.logger.log(`Seeded ${templates.length} system OTP templates`);
    }
  }

  // ── Channels (read) ────────────────────────────────────

  async findActiveChannels(): Promise<Channel[]> {
    return this.channelRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  async findAllChannels(): Promise<Channel[]> {
    return this.channelRepository.find({ order: { name: 'ASC' } });
  }

  /** Approved SYSTEM templates for a channel (available to everyone). */
  async findSystemTemplatesByChannel(
    channelId: string,
  ): Promise<OtpTemplate[]> {
    return this.templateRepository.find({
      where: { channelId, userId: IsNull(), status: TemplateStatus.APPROVED },
      order: { name: 'ASC' },
    });
  }

  // ── Send path (authorization-critical) ─────────────────

  /**
   * Resolve a template that the caller is allowed to SEND with: their own
   * approved template OR a system template. Never returns another user's
   * template — the OTP send path relies on this scoping.
   */
  async findUsableTemplate(
    userId: string,
    id: string,
  ): Promise<OtpTemplate | null> {
    const template = await this.templateRepository.findOne({
      where: { id, status: TemplateStatus.APPROVED },
    });
    if (!template) return null;
    if (template.userId !== null && template.userId !== userId) return null;
    return template;
  }

  // ── Customer template CRUD (owner-scoped) ──────────────

  async listMyTemplates(
    userId: string,
    query: {
      page: number;
      limit: number;
      status?: TemplateStatus;
      channelId?: string;
      search?: string;
    },
  ): Promise<[OtpTemplate[], number]> {
    const where: Record<string, unknown> = { userId };
    if (query.status) where.status = query.status;
    if (query.channelId) where.channelId = query.channelId;
    if (query.search) where.name = ILike(`%${query.search}%`);

    return this.templateRepository.findAndCount({
      where,
      relations: ['channel'],
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
  }

  /** Templates the user can send with right now: own approved + system approved. */
  async listAvailableTemplates(userId: string): Promise<OtpTemplate[]> {
    return this.templateRepository.find({
      where: [
        { userId, status: TemplateStatus.APPROVED },
        { userId: IsNull(), status: TemplateStatus.APPROVED },
      ],
      relations: ['channel'],
      order: { name: 'ASC' },
    });
  }

  async getMyTemplate(userId: string, id: string): Promise<OtpTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id },
      relations: ['channel'],
    });
    // A user can see their own template or any system template.
    if (!template || (template.userId !== null && template.userId !== userId)) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  async createMyTemplate(
    userId: string,
    data: { name: string; body: string; channelId: string; language?: string },
  ): Promise<OtpTemplate> {
    const channel = await this.channelRepository.findOne({
      where: { id: data.channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const template = this.templateRepository.create({
      userId,
      name: data.name,
      body: data.body,
      channelId: data.channelId,
      language: data.language ?? 'en',
      status: TemplateStatus.DRAFT,
    });
    return this.templateRepository.save(template);
  }

  private async getOwnedEditable(
    userId: string,
    id: string,
  ): Promise<OtpTemplate> {
    const template = await this.templateRepository.findOne({ where: { id } });
    if (!template || template.userId !== userId) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  async updateMyTemplate(
    userId: string,
    id: string,
    data: { name?: string; body?: string; language?: string },
  ): Promise<OtpTemplate> {
    const template = await this.getOwnedEditable(userId, id);
    if (!EDITABLE_STATUSES.includes(template.status)) {
      throw new BadRequestException(
        'Only draft or rejected templates can be edited',
      );
    }
    Object.assign(template, data);
    // Any edit resets the template to draft (must be re-reviewed).
    template.status = TemplateStatus.DRAFT;
    template.rejectionReason = null;
    return this.templateRepository.save(template);
  }

  async submitMyTemplate(userId: string, id: string): Promise<OtpTemplate> {
    const template = await this.getOwnedEditable(userId, id);
    if (!EDITABLE_STATUSES.includes(template.status)) {
      throw new BadRequestException(
        'Only draft or rejected templates can be submitted for review',
      );
    }
    template.status = TemplateStatus.PENDING_REVIEW;
    template.submittedAt = new Date();
    template.rejectionReason = null;
    return this.templateRepository.save(template);
  }

  async deleteMyTemplate(userId: string, id: string): Promise<void> {
    const template = await this.getOwnedEditable(userId, id);
    await this.templateRepository.softRemove(template);
  }

  // ── Admin review queue ─────────────────────────────────

  async findAllTemplatesAdmin(query: {
    page: number;
    limit: number;
    channelId?: string;
    status?: TemplateStatus;
    userId?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<[OtpTemplate[], number]> {
    const where: Record<string, unknown> = {};
    if (query.channelId) where.channelId = query.channelId;
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = query.userId;
    if (query.search) where.name = ILike(`%${query.search}%`);

    return this.templateRepository.findAndCount({
      where,
      relations: ['channel', 'user'],
      order: { [query.sortBy || 'createdAt']: query.sortOrder || 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
  }

  async findTemplateByIdAdmin(id: string): Promise<OtpTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id },
      relations: ['channel', 'user'],
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  /** Admin creates a shared SYSTEM template (userId = null), immediately approved. */
  async createSystemTemplate(data: {
    name: string;
    body: string;
    channelId: string;
    language?: string;
    metadata?: Record<string, any>;
  }): Promise<OtpTemplate> {
    const channel = await this.channelRepository.findOne({
      where: { id: data.channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const template = this.templateRepository.create({
      userId: null,
      name: data.name,
      body: data.body,
      channelId: data.channelId,
      language: data.language ?? 'en',
      metadata: data.metadata ?? null,
      status: TemplateStatus.APPROVED,
    });
    return this.templateRepository.save(template);
  }

  async approveTemplate(
    id: string,
    adminId: string,
    metadata?: Record<string, any>,
  ): Promise<OtpTemplate> {
    const template = await this.findTemplateByIdAdmin(id);
    if (template.status === TemplateStatus.APPROVED) {
      throw new BadRequestException('Template is already approved');
    }
    if (metadata) {
      template.metadata = { ...(template.metadata ?? {}), ...metadata };
    }
    template.status = TemplateStatus.APPROVED;
    template.rejectionReason = null;
    template.reviewedAt = new Date();
    template.reviewedBy = adminId;
    return this.templateRepository.save(template);
  }

  async rejectTemplate(
    id: string,
    adminId: string,
    rejectionReason: string,
  ): Promise<OtpTemplate> {
    const template = await this.findTemplateByIdAdmin(id);
    if (template.userId === null) {
      throw new ForbiddenException('System templates cannot be rejected');
    }
    template.status = TemplateStatus.REJECTED;
    template.rejectionReason = rejectionReason;
    template.reviewedAt = new Date();
    template.reviewedBy = adminId;
    return this.templateRepository.save(template);
  }

  async updateTemplateAdmin(
    id: string,
    data: {
      name?: string;
      body?: string;
      language?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<OtpTemplate> {
    const template = await this.findTemplateByIdAdmin(id);
    Object.assign(template, data);
    return this.templateRepository.save(template);
  }

  async deleteTemplateAdmin(id: string): Promise<void> {
    const template = await this.findTemplateByIdAdmin(id);
    await this.templateRepository.softRemove(template);
  }
}
