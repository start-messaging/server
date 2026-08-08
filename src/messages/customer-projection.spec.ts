import { MessagesService } from './messages.service.js';
import { Message, MessageStatus } from './entities/message.entity.js';
import {
  GENERIC_FAILURE_REASON,
  TWO_FACTOR_ERROR_MAP,
  customerFacingReason,
} from '../sms-providers/providers/two-factor-status.js';

/**
 * The platform resells SMS. Which provider sits behind it is commercial
 * information, and until 2026-08-08 it reached customers three ways: the whole
 * entity on one `check-status` branch, the provider's own rejection wording
 * copied into `failureReason`, and that same wording returned in the /otp/send
 * error body.
 *
 * These tests are the standing guard on all three.
 */

/** Anything that would identify the vendor or our account state with it. */
const PROVIDER_TELLS = [
  /2factor/i,
  /fast2sms/i,
  /twilio/i,
  /REJECTD/,
  /FAILED\(/,
  /SessionId/i,
  /API Key/i,
  /Invalid Template/i,
];

function assertNoProviderTells(value: string): void {
  for (const tell of PROVIDER_TELLS) {
    expect(value).not.toMatch(tell);
  }
}

describe('customer projection hides provider internals', () => {
  // `customerFields` is an instance field, so a bare prototype does not carry
  // it. None of the constructor dependencies are touched by the projection.
  const service = new MessagesService(
    null as never,
    null as never,
    null as never,
    null as never,
  ) as unknown as {
    pickCustomerFields(m: Message): Message;
    customerFields: (keyof Message)[];
  };

  const fullRow = {
    id: 'm1',
    userId: 'u1',
    phoneNumber: '+911111111111',
    content: 'OTP sent',
    status: MessageStatus.FAILED,
    costAmount: 0,
    failureReason: GENERIC_FAILURE_REASON,
    // Everything below must not survive the projection.
    provider: '2factor',
    providerMsgId: 'msjabc-deadbeef',
    providerCost: 0.18,
    providerStatusDescription: 'FAILED(BARRED)',
    providerFailureReason: 'Invalid Template Name',
    renderedContent: 'Your ACME OTP is ****',
    otpTemplateId: 't1',
    metadata: {
      intendedCost: 0.25,
      report_payload: { statusDesc: 'REJECTD', errorId: '633' },
    },
  } as unknown as Message;

  const HIDDEN = [
    'provider',
    'providerMsgId',
    'providerCost',
    'providerStatusDescription',
    'providerFailureReason',
    'renderedContent',
    'metadata',
  ];

  it.each(HIDDEN)('drops %s', (field) => {
    expect(service.customerFields).not.toContain(field);
    expect(service.pickCustomerFields(fullRow)).not.toHaveProperty(field);
  });

  it('keeps the fields the dashboard actually renders', () => {
    const picked = service.pickCustomerFields(fullRow);

    for (const field of [
      'id',
      'phoneNumber',
      'status',
      'costAmount',
      'failureReason',
      'content',
    ]) {
      expect(picked).toHaveProperty(field);
    }
  });

  it('never names the provider in a customer-visible reason', () => {
    assertNoProviderTells(service.pickCustomerFields(fullRow).failureReason!);
  });
});

describe('customerFacingReason', () => {
  it('returns the curated explanation for a known code', () => {
    expect(customerFacingReason('154')).toBe(
      TWO_FACTOR_ERROR_MAP['154'].reason,
    );
  });

  it('collapses unknown codes to the generic sentence', () => {
    // A whitelist, not a blocklist: wording nobody has reviewed — including
    // any the provider invents later — must never be passed through.
    for (const code of ['', '999', 'ZZZ', 'REJECTD']) {
      expect(customerFacingReason(code)).toBe(GENERIC_FAILURE_REASON);
    }
  });

  it('emits no provider tells for any curated reason', () => {
    for (const { reason } of Object.values(TWO_FACTOR_ERROR_MAP)) {
      assertNoProviderTells(reason);
    }
    assertNoProviderTells(GENERIC_FAILURE_REASON);
  });
});
