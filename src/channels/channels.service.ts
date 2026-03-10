import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { Channel } from './entities/channel.entity.js';
import { OtpTemplate } from './entities/otp-template.entity.js';
import { TemplateStatus } from './enums/template-status.enum.js';

const SYSTEM_TEMPLATES = [
  {
    name: 'Default OTP',
    body: 'Your verification code is {{otp}}. Valid for {{expiry}} minutes.',
  },
  {
    name: 'Login Verification',
    body: '{{otp}} is your OTP for {{appName}}. Do not share with anyone.',
  },
  {
    name: 'Account Verification',
    body: 'Use {{otp}} to verify your account. Expires in {{expiry}} minutes.',
  },
  {
    name: 'One-Time Password',
    body: 'Your one-time password is {{otp}}. It is valid for {{expiry}} minutes.',
  },
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

    const templateCount = await this.templateRepository.count({
      where: { channelId: smsChannel.id },
    });

    if (templateCount === 0) {
      const templates = SYSTEM_TEMPLATES.map((t) =>
        this.templateRepository.create({
          ...t,
          channelId: smsChannel.id,
          status: TemplateStatus.PUBLISHED,
          language: 'en',
        }),
      );
      await this.templateRepository.save(templates);
      this.logger.log(`Seeded ${templates.length} default OTP templates`);
    }
  }

  async findActiveChannels(): Promise<Channel[]> {
    return this.channelRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  async findTemplatesByChannel(channelId: string): Promise<OtpTemplate[]> {
    return this.templateRepository.find({
      where: { channelId, status: TemplateStatus.PUBLISHED },
      order: { name: 'ASC' },
    });
  }

  async findAllActiveTemplates(): Promise<OtpTemplate[]> {
    return this.templateRepository.find({
      where: { status: TemplateStatus.PUBLISHED },
      relations: ['channel'],
      order: { name: 'ASC' },
    });
  }

  async findTemplateById(id: string): Promise<OtpTemplate | null> {
    return this.templateRepository.findOne({
      where: { id, status: TemplateStatus.PUBLISHED },
    });
  }

  // ── Admin methods ──────────────────────────────────────

  async findAllChannels(): Promise<Channel[]> {
    return this.channelRepository.find({ order: { name: 'ASC' } });
  }

  async findAllTemplatesAdmin(query: {
    page: number;
    limit: number;
    channelId?: string;
    status?: TemplateStatus;
    search?: string;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<[OtpTemplate[], number]> {
    const where: any = {};
    if (query.channelId) where.channelId = query.channelId;
    if (query.status) where.status = query.status;
    if (query.search) where.name = ILike(`%${query.search}%`);

    return this.templateRepository.findAndCount({
      where,
      relations: ['channel'],
      order: { [query.sortBy || 'createdAt']: query.sortOrder || 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
  }

  async findTemplateByIdAdmin(id: string): Promise<OtpTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id },
      relations: ['channel'],
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async createTemplate(data: {
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
      ...data,
      status: TemplateStatus.DRAFT,
    });
    return this.templateRepository.save(template);
  }

  async updateTemplate(
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

  async publishTemplate(id: string): Promise<OtpTemplate> {
    const template = await this.findTemplateByIdAdmin(id);

    if (template.status === TemplateStatus.PUBLISHED) {
      throw new BadRequestException('Template is already published');
    }

    template.status = TemplateStatus.PUBLISHED;
    return this.templateRepository.save(template);
  }

  async unpublishTemplate(id: string): Promise<OtpTemplate> {
    const template = await this.findTemplateByIdAdmin(id);

    if (template.status === TemplateStatus.DRAFT) {
      throw new BadRequestException('Template is already a draft');
    }

    template.status = TemplateStatus.DRAFT;
    return this.templateRepository.save(template);
  }

  async deleteTemplate(id: string): Promise<void> {
    const template = await this.findTemplateByIdAdmin(id);

    await this.templateRepository.softRemove(template);
  }
}
