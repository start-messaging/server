import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  Repository,
} from 'typeorm';
import { Message, MessageStatus } from './entities/message.entity.js';
import { SmsProviderFactory } from '../sms-providers/sms-provider.factory.js';
import { WalletService } from '../wallet/wallet.service.js';

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly smsProviderFactory: SmsProviderFactory,
    private readonly walletService: WalletService,
    private readonly dataSource: DataSource,
  ) {}

  async create(data: Partial<Message>): Promise<Message> {
    const status = data.status || MessageStatus.INITIATED;
    const message = this.messageRepository.create({
      ...data,
      status,
      statusHistory: [{ status, timestamp: new Date().toISOString() }],
    });
    return this.messageRepository.save(message);
  }

  /**
   * Syncs status with provider and handles deferred debit on success
   */
  async syncProviderStatus(messageId: string): Promise<Message> {
    const message = await this.messageRepository.findOneOrFail({
      where: { id: messageId },
    });

    if (!message.providerMsgId) return message;

    const dlr = await this.smsProviderFactory.getDeliveryStatus(
      message.provider,
      message.providerMsgId,
    );

    if (dlr.status === 'unknown') return message;

    const mappedStatus = this.mapProviderStatus(dlr.status);
    if (!mappedStatus) return message;

    return this.handleStatusUpdate(message, mappedStatus, {
      deliveredAt:
        dlr.deliveredAt ||
        (mappedStatus === MessageStatus.DELIVERED ? new Date() : null),
      senderId: dlr.senderId || message.senderId,
      smsLanguage: dlr.smsLanguage || message.smsLanguage,
      characterCount: dlr.characterCount || message.characterCount,
      smsCount: dlr.smsCount || message.smsCount,
      providerCost: dlr.providerCost || message.providerCost,
      providerStatusDescription:
        dlr.description || message.providerStatusDescription,
      metadata: dlr.rawResponse || message.metadata,
    });
  }

  /**
   * Universal handler for status updates from ANY source (Polling or Webhook)
   * Handles business logic like deferred wallet debiting.
   *
   * Wallet debit and message status update run inside a single transaction
   * so they either both commit or both rollback.
   */
  async handleStatusUpdate(
    message: Message,
    newStatus: MessageStatus,
    extraFields?: Partial<Message>,
  ): Promise<Message> {
    // Reset cost for failed/expired messages to reflect actual spend
    if (
      newStatus === MessageStatus.FAILED ||
      newStatus === MessageStatus.EXPIRED
    ) {
      extraFields = { ...extraFields, costAmount: 0 };
    }

    return this.dataSource.transaction(async (manager) => {
      // Deferred Debit: only debit on first transition to DELIVERED
      if (
        newStatus === MessageStatus.DELIVERED &&
        message.status !== MessageStatus.DELIVERED
      ) {
        const debitAmount =
          message.costAmount > 0
            ? Number(message.costAmount)
            : Number(message.metadata?.intendedCost || 0);

        if (debitAmount > 0) {
          await this.walletService.debit(
            message.userId,
            debitAmount,
            `OTP delivered to ${message.phoneNumber}`,
            'otp_usage',
            message.id,
            manager,
          );
          // Set costAmount now so it shows in dashboard
          extraFields = { ...extraFields, costAmount: debitAmount };
        }
      }

      return this.updateStatus(message.id, newStatus, extraFields, manager);
    });
  }

  async updateStatus(
    id: string,
    status: MessageStatus,
    extra?: Partial<Message>,
    manager?: EntityManager,
  ): Promise<Message> {
    const repo = manager
      ? manager.getRepository(Message)
      : this.messageRepository;

    const message = await repo.findOneOrFail({
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

    return repo.save(message);
  }

  private readonly customerFields: (keyof Message)[] = [
    'id',
    'userId',
    'apiKeyId',
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
    status?: string,
    apiKeyId?: string,
  ): Promise<[Message[], number]> {
    const qb = this.messageRepository
      .createQueryBuilder('m')
      .select(this.customerFields.map((f) => `m.${f}`))
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
    if (apiKeyId) {
      qb.andWhere('m.apiKeyId = :apiKeyId', { apiKeyId });
    }

    return qb
      .orderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
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

  async findByProviderMsgId(providerMsgId: string): Promise<Message | null> {
    return this.messageRepository.findOne({
      where: { providerMsgId },
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

    const dlr = await this.smsProviderFactory.getDeliveryStatus(
      message.provider,
      message.providerMsgId,
    );

    const mappedStatus = this.mapProviderStatus(dlr.status);

    if (mappedStatus && mappedStatus !== message.status) {
      return this.syncProviderStatus(id);
    }

    return this.pickCustomerFields(message);
  }

  private mapProviderStatus(
    status: 'sent' | 'delivered' | 'failed' | 'unknown',
  ): MessageStatus | null {
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
      .addSelect(
        `COALESCE(SUM(m.costAmount) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}'), 0)`,
        'totalSpent',
      )
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
      .addSelect(
        `COALESCE(SUM(m.costAmount) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}'), 0)`,
        'totalRevenue',
      )
      .getRawOne();

    return {
      totalMessages: parseInt(result.totalMessages, 10),
      totalRevenue: parseFloat(result.totalRevenue),
    };
  }

  async getAdminDashboardStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const stats = await this.messageRepository
      .createQueryBuilder('m')
      .select('COUNT(*)', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}')`,
        'delivered',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.FAILED}')`,
        'failed',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.createdAt >= :todayStart)`,
        'todayCount',
      )
      .setParameter('todayStart', todayStart)
      .getRawOne();

    return {
      total: parseInt(stats.total, 10),
      delivered: parseInt(stats.delivered, 10),
      failed: parseInt(stats.failed, 10),
      todayCount: parseInt(stats.todayCount, 10),
      successRate: stats.total > 0 ? (stats.delivered / stats.total) * 100 : 0,
    };
  }

  async getAdminTrends(days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const result = await this.messageRepository
      .createQueryBuilder('m')
      .select("TO_CHAR(m.createdAt, 'YYYY-MM-DD')", 'date')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}')`,
        'delivered',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.FAILED}')`,
        'failed',
      )
      .where('m.createdAt >= :startDate', { startDate })
      .groupBy("TO_CHAR(m.createdAt, 'YYYY-MM-DD')")
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({
      date: r.date,
      total: parseInt(r.total, 10),
      delivered: parseInt(r.delivered, 10),
      failed: parseInt(r.failed, 10),
    }));
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
      .addSelect(
        `COALESCE(SUM(m.costAmount) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}'), 0)`,
        'cost',
      )
      .where('m.userId = :userId', { userId })
      .andWhere('m.createdAt >= :rangeStart', { rangeStart });

    if (rangeEnd) {
      filteredQuery.andWhere('m.createdAt <= :rangeEnd', { rangeEnd });
    }

    const filteredStats = await filteredQuery.getRawOne();

    const totalStats = await this.messageRepository
      .createQueryBuilder('m')
      .select('COUNT(*)', 'messages')
      .addSelect(
        `COALESCE(SUM(m.costAmount) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}'), 0)`,
        'cost',
      )
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

  async getDashboardTrends(userId: string, days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const result = await this.messageRepository
      .createQueryBuilder('m')
      .select("TO_CHAR(m.createdAt, 'YYYY-MM-DD')", 'date')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}')`,
        'delivered',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.FAILED}')`,
        'failed',
      )
      .where('m.userId = :userId', { userId })
      .andWhere('m.createdAt >= :startDate', { startDate })
      .groupBy("TO_CHAR(m.createdAt, 'YYYY-MM-DD')")
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({
      date: r.date,
      total: parseInt(r.total, 10),
      delivered: parseInt(r.delivered, 10),
      failed: parseInt(r.failed, 10),
    }));
  }

  async getAdminDailyUsage(dateString?: string) {
    const startDate = dateString ? new Date(dateString) : new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const result = await this.messageRepository
      .createQueryBuilder('m')
      .leftJoin('m.user', 'user')
      .select('user.id', 'userId')
      .addSelect('user.firstName', 'firstName')
      .addSelect('user.lastName', 'lastName')
      .addSelect('user.email', 'email')
      .addSelect('user.businessName', 'businessName')
      .addSelect('COUNT(*)', 'totalMessages')
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}')`,
        'deliveredCount',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE m.status = '${MessageStatus.FAILED}')`,
        'failedCount',
      )
      .addSelect(
        `COALESCE(SUM(m.costAmount) FILTER (WHERE m.status = '${MessageStatus.DELIVERED}'), 0)`,
        'totalSpent',
      )
      .where('m.createdAt >= :startDate', { startDate })
      .andWhere('m.createdAt < :endDate', { endDate })
      .andWhere('user.id IS NOT NULL')
      .groupBy('user.id')
      .addGroupBy('user.firstName')
      .addGroupBy('user.lastName')
      .addGroupBy('user.email')
      .addGroupBy('user.businessName')
      .orderBy('"totalMessages"', 'DESC')
      .getRawMany();

    return result.map((r) => ({
      user: {
        id: r.userId,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        businessName: r.businessName,
      },
      totalMessages: parseInt(r.totalMessages, 10),
      deliveredCount: parseInt(r.deliveredCount, 10),
      failedCount: parseInt(r.failedCount, 10),
      totalSpent: parseFloat(r.totalSpent),
    }));
  }
}
