import { SmsWebhookProcessor } from './sms-webhook.processor.js';
import { MessageStatus } from '../entities/message.entity.js';

/**
 * The webhook path is the one that has always worked — 3,956 of 3,973
 * OTP-endpoint sends resolved through it in the week these tests were written.
 * Its decoding tables were moved out to be shared with the report poller, so
 * these lock in that the move changed nothing.
 *
 * Payload shapes are copied from production logs.
 */
describe('SmsWebhookProcessor', () => {
  let handleStatusUpdate: jest.Mock;
  let processor: SmsWebhookProcessor;

  const message = {
    id: 'm1',
    metadata: { intendedCost: 0.25 },
    failureReason: null,
  };

  beforeEach(() => {
    handleStatusUpdate = jest.fn().mockResolvedValue(message);
    processor = new SmsWebhookProcessor({
      findByProviderMsgId: jest.fn().mockResolvedValue(message),
      handleStatusUpdate,
    } as any);
  });

  const run = (payload: Record<string, unknown>) =>
    processor.process({ data: payload } as any);

  const statusOf = () => handleStatusUpdate.mock.calls[0][1];
  const extrasOf = () => handleStatusUpdate.mock.calls[0][2];

  it('marks a DELIVERED receipt delivered and stamps deliveredAt', async () => {
    await run({
      mode: 'SMS_OTP',
      SessionId: 'msj66qrgkp6bw3i5h8q-a277b79e59675644',
      Status: 'DELIVERED',
      To: '918305891734',
      Retry: '0',
      Error: '000',
      SmsStatus: 'DELIVERED',
    });

    expect(statusOf()).toBe(MessageStatus.DELIVERED);
    expect(extrasOf().deliveredAt).toBeInstanceOf(Date);
  });

  it('maps a barring error code to failed with the barring explanation', async () => {
    await run({ SessionId: 's', SmsStatus: 'FAILED', Error: '154' });

    expect(statusOf()).toBe(MessageStatus.FAILED);
    expect(extrasOf().failureReason).toContain('barring');
  });

  it('zero-pads short error codes before lookup', async () => {
    // The webhook sends `13` where the report API sends `013`.
    await run({ SessionId: 's', SmsStatus: 'FAILED', Error: '13' });

    expect(statusOf()).toBe(MessageStatus.FAILED);
    expect(extrasOf().failureReason).toContain('barring');
  });

  it('falls back to the status name when the code is unmapped', async () => {
    await run({
      SessionId: 's',
      SmsStatus: 'FAILED',
      StatusDescription: 'Handset barred',
      Error: '999',
    });

    expect(statusOf()).toBe(MessageStatus.FAILED);
    expect(extrasOf().failureReason).toContain('barring');
  });

  it('leaves an unrecognised status non-terminal rather than failing it', async () => {
    await run({ SessionId: 's', SmsStatus: 'SOMETHING-NEW' });

    expect(statusOf()).toBe(MessageStatus.SENT);
    expect(extrasOf().deliveredAt).toBeNull();
  });

  it('ignores a payload with no session id', async () => {
    const result = await run({ Status: 'DELIVERED' });

    expect(handleStatusUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      reason: 'Missing SessionId or SmsStatus',
    });
  });

  it('preserves existing metadata alongside the webhook payload', async () => {
    await run({ SessionId: 's', SmsStatus: 'DELIVERED', Error: '000' });

    expect(extrasOf().metadata.intendedCost).toBe(0.25);
    expect(extrasOf().metadata.webhook_payload).toBeDefined();
  });
});
