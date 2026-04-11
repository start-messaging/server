import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessagesService } from '../messages.service.js';
import { MessageStatus } from '../entities/message.entity.js';

@Processor('sms-status')
export class SmsStatusProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsStatusProcessor.name);

  constructor(private readonly messagesService: MessagesService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { messageId } = job.data;

    this.logger.debug(
      `Processing status check for message: ${messageId} (Attempt: ${job.attemptsMade + 1})`,
    );

    try {
      const result = await this.messagesService.syncProviderStatus(messageId);

      if (
        result.status === MessageStatus.DELIVERED ||
        result.status === MessageStatus.FAILED
      ) {
        this.logger.log(
          `Message ${messageId} reached terminal state: ${result.status}`,
        );
        return result;
      }

      // If still pending/sent and we haven't timed out, retry
      const jobAgeMinutes = (Date.now() - job.timestamp) / 60000;
      if (jobAgeMinutes < 5) {
        throw new Error('Still pending, re-queueing for check');
      } else {
        this.logger.warn(
          `Message ${messageId} timed out after 5 minutes. Marking as FAILED.`,
        );
        await this.messagesService.updateStatus(
          messageId,
          MessageStatus.FAILED,
          {
            failureReason: 'Delivery status check timed out (5m)',
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `Error processing status for ${messageId}: ${error.message}`,
      );
      throw error; // Let BullMQ handle retry based on backoff
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
  }
}
