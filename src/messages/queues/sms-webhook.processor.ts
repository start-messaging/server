import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessagesService } from '../messages.service.js';
import { MessageStatus } from '../entities/message.entity.js';

@Processor('sms-webhook')
export class SmsWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsWebhookProcessor.name);

  constructor(private readonly messagesService: MessagesService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const payload = job.data;
    this.logger.log(`Processing 2Factor webhook update: ${JSON.stringify(payload)}`);

    const sessionId = payload.SessionId;
    const smsStatus = payload.SmsStatus;

    if (!sessionId || !smsStatus) {
      this.logger.warn(`Invalid 2Factor webhook payload: ${JSON.stringify(payload)}`);
      return { success: false, reason: 'Missing SessionId or SmsStatus' };
    }

    const message = await this.messagesService.findByProviderMsgId(sessionId);
    if (!message) {
      this.logger.warn(`No message found for 2Factor SessionId: ${sessionId}`);
      return { success: false, reason: 'Message not found' };
    }

    const mappedStatus = this.mapTwoFactorStatus(smsStatus);
    
    await this.messagesService.handleStatusUpdate(message, mappedStatus, {
      providerStatusDescription: payload.StatusDescription || payload.StatusName,
      metadata: { ...message.metadata, webhook_payload: payload },
      deliveredAt: mappedStatus === MessageStatus.DELIVERED ? new Date() : null,
    });

    return { success: true };
  }

  private mapTwoFactorStatus(status: string): MessageStatus {
    const s = (status || '').toUpperCase();
    if (s.includes('DELIVERED')) return MessageStatus.DELIVERED;
    if (s.includes('FAILED') || s.includes('REJECTED') || s.includes('UNDELIVERED') || s.includes('NO-ANSWER') || s.includes('ERROR')) return MessageStatus.FAILED;
    if (s.includes('SENT') || s.includes('SUBMITTED')) return MessageStatus.SENT;
    return MessageStatus.INITIATED;
  }
}
