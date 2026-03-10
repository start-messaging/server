import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { Message, MessageStatus } from './entities/message.entity.js';
import { SmsProviderFactory } from '../sms-providers/sms-provider.factory.js';

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly smsProviderFactory: SmsProviderFactory,
  ) {}

  async create(data: Partial<Message>): Promise<Message> {
    const message = this.messageRepository.create({
      ...data,
      statusHistory: [
        { status: MessageStatus.QUEUED, timestamp: new Date().toISOString() },
      ],
    });
    return this.messageRepository.save(message);
  }

  async updateStatus(
    id: string,
    status: MessageStatus,
    extra?: Partial<Message>,
  ): Promise<Message> {
    const message = await this.messageRepository.findOneOrFail({
      where: { id },
    });

    message.status = status;
    message.statusHistory = [
      ...message.statusHistory,
      { status, timestamp: new Date().toISOString() },
    ];

    if (extra) {
      Object.assign(message, extra);
    }

    return this.messageRepository.save(message);
  }

  private readonly customerFields: (keyof Message)[] = [
    'id',
    'userId',
    'phoneNumber',
    'content',
    'status',
    'statusHistory',
    'costAmount',
    'failureReason',
    'sentAt',
    'deliveredAt',
    'createdAt',
    'updatedAt',
  ];

  async findByUser(
    userId: string,
    page: number,
    limit: number,
    startDate?: string,
    endDate?: string,
  ): Promise<[Message[], number]> {
    const where: FindOptionsWhere<Message> = { userId };

    if (startDate) {
      where.createdAt = MoreThanOrEqual(new Date(startDate));
    }
    if (endDate) {
      where.createdAt =
        endDate && startDate
          ? MoreThanOrEqual(new Date(startDate))
          : LessThanOrEqual(new Date(endDate));
    }

    // When both are provided, we need a custom query
    if (startDate && endDate) {
      return this.messageRepository
        .createQueryBuilder('m')
        .select(this.customerFields.map((f) => `m.${f}`))
        .where('m.userId = :userId', { userId })
        .andWhere('m.createdAt >= :startDate', {
          startDate: new Date(startDate),
        })
        .andWhere('m.createdAt <= :endDate', { endDate: new Date(endDate) })
        .orderBy('m.createdAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();
    }

    return this.messageRepository.findAndCount({
      select: this.customerFields,
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async findById(id: string, userId?: string): Promise<Message | null> {
    const where: FindOptionsWhere<Message> = { id };
    if (userId) {
      where.userId = userId;
    }
    return this.messageRepository.findOne({
      select: this.customerFields,
      where,
    });
  }

  async checkStatus(id: string, userId: string): Promise<Message> {
    const message = await this.messageRepository.findOne({
      where: { id, userId },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    const terminalStatuses = [
      MessageStatus.DELIVERED,
      MessageStatus.FAILED,
      MessageStatus.EXPIRED,
    ];
    if (terminalStatuses.includes(message.status)) {
      return this.pickCustomerFields(message);
    }

    if (!message.providerMsgId) {
      return this.pickCustomerFields(message);
    }

    const providerStatus = await this.smsProviderFactory.getDeliveryStatus(
      message.provider,
      message.providerMsgId,
    );

    const mappedStatus = this.mapProviderStatus(providerStatus);

    if (mappedStatus && mappedStatus !== message.status) {
      const extra: Partial<Message> = {};
      if (mappedStatus === MessageStatus.DELIVERED) {
        extra.deliveredAt = new Date();
      }
      const updated = await this.updateStatus(id, mappedStatus, extra);
      return this.pickCustomerFields(updated);
    }

    return this.pickCustomerFields(message);
  }

  private mapProviderStatus(status: string): MessageStatus | null {
    switch (status) {
      case 'delivered':
        return MessageStatus.DELIVERED;
      case 'failed':
        return MessageStatus.FAILED;
      case 'sent':
        return MessageStatus.SENT;
      default:
        return null;
    }
  }

  private pickCustomerFields(message: Message): Message {
    const picked = {} as Message;
    for (const field of this.customerFields) {
      (picked as any)[field] = message[field];
    }
    return picked;
  }

  async findByUserAdmin(
    userId: string,
    page: number,
    limit: number,
    startDate?: string,
    endDate?: string,
    status?: MessageStatus,
    phoneNumber?: string,
  ): Promise<[Message[], number]> {
    const qb = this.messageRepository
      .createQueryBuilder('m')
      .where('m.userId = :userId', { userId });

    if (startDate) {
      qb.andWhere('m.createdAt >= :startDate', {
        startDate: new Date(startDate),
      });
    }
    if (endDate) {
      qb.andWhere('m.createdAt <= :endDate', { endDate: new Date(endDate) });
    }
    if (status) {
      qb.andWhere('m.status = :status', { status });
    }
    if (phoneNumber) {
      qb.andWhere('m.phoneNumber ILIKE :phone', {
        phone: `%${phoneNumber}%`,
      });
    }

    return qb
      .orderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  async getAdminUserStats(userId: string) {
    const result = await this.messageRepository
      .createQueryBuilder('m')
      .select('COUNT(*)', 'totalMessages')
      .addSelect('COALESCE(SUM(m.costAmount), 0)', 'totalSpent')
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.QUEUED}')`,
        'queued',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.SENT}')`,
        'sent',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}')`,
        'delivered',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.FAILED}')`,
        'failed',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.EXPIRED}')`,
        'expired',
      )
      .where('m.userId = :userId', { userId })
      .getRawOne();

    return {
      totalMessages: parseInt(result.totalMessages, 10),
      totalSpent: parseFloat(result.totalSpent),
      statusBreakdown: {
        queued: parseInt(result.queued, 10),
        sent: parseInt(result.sent, 10),
        delivered: parseInt(result.delivered, 10),
        failed: parseInt(result.failed, 10),
        expired: parseInt(result.expired, 10),
      },
    };
  }

  async getAdminStats() {
    const result = await this.messageRepository
      .createQueryBuilder('m')
      .select('COUNT(*)', 'totalMessages')
      .addSelect('COALESCE(SUM(m.costAmount), 0)', 'totalRevenue')
      .getRawOne();

    return {
      totalMessages: parseInt(result.totalMessages, 10),
      totalRevenue: parseFloat(result.totalRevenue),
    };
  }

  async getDashboardStats(
    userId: string,
    startDate?: string,
    endDate?: string,
  ) {
    const rangeStart = startDate ? new Date(startDate) : new Date();
    if (!startDate) rangeStart.setHours(0, 0, 0, 0);

    const rangeEnd = endDate ? new Date(endDate) : undefined;

    const filteredQuery = this.messageRepository
      .createQueryBuilder('m')
      .select('COUNT(*)', 'requested')
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}')`,
        'delivered',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.FAILED}')`,
        'failed',
      )
      .addSelect('COALESCE(SUM(m.costAmount), 0)', 'cost')
      .where('m.userId = :userId', { userId })
      .andWhere('m.createdAt >= :rangeStart', { rangeStart });

    if (rangeEnd) {
      filteredQuery.andWhere('m.createdAt <= :rangeEnd', { rangeEnd });
    }

    const filteredStats = await filteredQuery.getRawOne();

    const totalStats = await this.messageRepository
      .createQueryBuilder('m')
      .select('COUNT(*)', 'messages')
      .addSelect('COALESCE(SUM(m.costAmount), 0)', 'cost')
      .where('m.userId = :userId', { userId })
      .getRawOne();

    return {
      filtered: {
        requested: parseInt(filteredStats.requested, 10),
        delivered: parseInt(filteredStats.delivered, 10),
        failed: parseInt(filteredStats.failed, 10),
        cost: parseFloat(filteredStats.cost),
      },
      total: {
        messages: parseInt(totalStats.messages, 10),
        cost: parseFloat(totalStats.cost),
      },
    };
  }
}
