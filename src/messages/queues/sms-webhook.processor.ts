import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessagesService } from '../messages.service.js';
import { MessageStatus } from '../entities/message.entity.js';
import {
  BARRED_REASON,
  GENERIC_FAILURE_REASON,
  TWO_FACTOR_ERROR_MAP,
  TwoFactorOutcome,
  mapTwoFactorStatusName,
  normalizeErrorCode,
} from '../../sms-providers/providers/two-factor-status.js';

/** The shared vocabulary speaks in outcomes; this queue stores MessageStatus. */
const TO_MESSAGE_STATUS: Record<TwoFactorOutcome, MessageStatus> = {
  delivered: MessageStatus.DELIVERED,
  failed: MessageStatus.FAILED,
  sent: MessageStatus.SENT,
  unknown: MessageStatus.SENT,
};

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
    const smsStatus = payload.SmsStatus || payload.Status;

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
    // 2Factor's own wording, kept for admins only.
    const providerReason: string | null =
      payload.StatusDescription || payload.StatusName || smsStatus || null;

    // 1. Check Error Code first (more specific)
    const errorCode = normalizeErrorCode(payload.Error);
    const mapped = errorCode ? TWO_FACTOR_ERROR_MAP[errorCode] : undefined;

    if (mapped) {
      mappedStatus = TO_MESSAGE_STATUS[mapped.outcome];
      failureReason = mapped.reason;
    } else {
      // 2. Fallback to status name
      mappedStatus = TO_MESSAGE_STATUS[mapTwoFactorStatusName(smsStatus)];
      if (mappedStatus === MessageStatus.FAILED) {
        const fullStatus =
          `${smsStatus} ${payload.StatusDescription || ''} ${payload.StatusName || ''}`.toUpperCase();
        // Only curated text reaches the customer. The provider's own strings
        // (REJECTD, FAILED(BARRED), operator/DLT wording) name the provider.
        failureReason = fullStatus.includes('BARRED')
          ? BARRED_REASON
          : GENERIC_FAILURE_REASON;
      }
    }

    await this.messagesService.handleStatusUpdate(message, mappedStatus, {
      providerStatusDescription:
        payload.StatusDescription ||
        payload.StatusName ||
        (errorCode ? `Error ${errorCode}` : null),
      failureReason: failureReason || message.failureReason,
      providerFailureReason:
        mappedStatus === MessageStatus.FAILED
          ? (providerReason ?? message.providerFailureReason)
          : message.providerFailureReason,
      metadata: { ...message.metadata, webhook_payload: payload },
      deliveredAt: mappedStatus === MessageStatus.DELIVERED ? new Date() : null,
    });

    return { success: true };
  }
}
