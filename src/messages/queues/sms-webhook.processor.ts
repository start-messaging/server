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
    this.logger.log(
      `Processing 2Factor webhook update: ${JSON.stringify(payload)}`,
    );

    const sessionId = payload.SessionId;
    const smsStatus = payload.SmsStatus;

    if (!sessionId || !smsStatus) {
      this.logger.warn(
        `Invalid 2Factor webhook payload: ${JSON.stringify(payload)}`,
      );
      return { success: false, reason: 'Missing SessionId or SmsStatus' };
    }

    const message = await this.messagesService.findByProviderMsgId(sessionId);
    if (!message) {
      this.logger.warn(`No message found for 2Factor SessionId: ${sessionId}`);
      return { success: false, reason: 'Message not found' };
    }

    let mappedStatus: MessageStatus;
    let failureReason: string | null = null;

    // 1. Check Error Code first (more specific)
    const errorCode = String(payload.Error || '');
    const errorMap = this.getTwoFactorErrorMap();

    if (errorCode && errorMap[errorCode]) {
      const mapped = errorMap[errorCode];
      mappedStatus = mapped.status;
      failureReason = mapped.reason;
    } else {
      // 2. Fallback to status name
      mappedStatus = this.mapTwoFactorStatus(smsStatus);
      if (mappedStatus === MessageStatus.FAILED) {
        const fullStatus = `${smsStatus} ${payload.StatusDescription || ''} ${payload.StatusName || ''}`.toUpperCase();
        if (fullStatus.includes('BARRED')) {
          failureReason =
            'Message delivery failed due to message service barring on the recipient number. In many cases, this occurs when the recipient does not maintain sufficient balance, resulting in the suspension of incoming services on the number.';
        } else {
          failureReason =
            payload.StatusDescription ||
            payload.StatusName ||
            'Message delivery failed';
        }
      }
    }

    await this.messagesService.handleStatusUpdate(message, mappedStatus, {
      providerStatusDescription:
        payload.StatusDescription ||
        payload.StatusName ||
        (errorCode ? `Error ${errorCode}` : null),
      failureReason: failureReason || message.failureReason,
      metadata: { ...message.metadata, webhook_payload: payload },
      deliveredAt: mappedStatus === MessageStatus.DELIVERED ? new Date() : null,
    });

    return { success: true };
  }

  private getTwoFactorErrorMap(): Record<
    string,
    { status: MessageStatus; reason: string }
  > {
    const barredMessage =
      'Message delivery failed due to message service barring on the recipient number. In many cases, this occurs when the recipient does not maintain sufficient balance, resulting in the suspension of incoming services on the number.';

    return {
      '0': { status: MessageStatus.DELIVERED, reason: 'Delivered' },
      '21': {
        status: MessageStatus.FAILED,
        reason:
          'Facility not supported by network. This might be due to insufficient balance or message service facility being unavailable for this number.',
      },
      '13': {
        status: MessageStatus.FAILED,
        reason: barredMessage,
      },
      '11': {
        status: MessageStatus.FAILED,
        reason: barredMessage,
      },
      '151': {
        status: MessageStatus.FAILED,
        reason: barredMessage,
      },
      '154': {
        status: MessageStatus.FAILED,
        reason: barredMessage,
      },
      '109': {
        status: MessageStatus.FAILED,
        reason: 'Invalid or incorrectly formatted recipient number.',
      },
      '180': {
        status: MessageStatus.FAILED,
        reason:
          'Destination telecom network was temporarily unreachable. Please retry after some time.',
      },
      '27': {
        status: MessageStatus.FAILED,
        reason: 'Recipient is unreachable (switched off or out of coverage area).',
      },
      '33': {
        status: MessageStatus.FAILED,
        reason: "Message delivery failed as the recipient's network message queue is full.",
      },
      '88': {
        status: MessageStatus.FAILED,
        reason: 'Network timeout while fetching recipient details. Please retry.',
      },
      '32': {
        status: MessageStatus.FAILED,
        reason: "Recipient's phone memory is full. Message could not be delivered.",
      },
      '5': {
        status: MessageStatus.FAILED,
        reason: 'Unidentified subscriber. The recipient number is not allocated or active.',
      },
      '1': {
        status: MessageStatus.FAILED,
        reason: 'General network failure or recipient did not answer.',
      },
    };
  }

  private mapTwoFactorStatus(status: string): MessageStatus {
    const s = (status || '').toUpperCase();
    if (s.includes('DELIVERED')) return MessageStatus.DELIVERED;
    if (
      s.includes('FAILED') ||
      s.includes('REJECTED') ||
      s.includes('UNDELIVERED') ||
      s.includes('NO-ANSWER') ||
      s.includes('ERROR')
    )
      return MessageStatus.FAILED;
    if (s.includes('SENT') || s.includes('SUBMITTED'))
      return MessageStatus.SENT;
    return MessageStatus.INITIATED;
  }
}
