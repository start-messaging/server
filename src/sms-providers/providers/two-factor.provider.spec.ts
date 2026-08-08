import { TwoFactorProvider } from './two-factor.provider.js';
import { parseIstTimestamp } from './two-factor-status.js';
import { DlrResult } from '../sms-provider.interface.js';

/**
 * The XML in these tests is copied verbatim from production responses captured
 * on 2026-08-08 for three real stuck messages, plus the answer 2Factor gives
 * for an OTP-endpoint session id. Handwritten fixtures would have hidden the
 * two things that actually mattered: that `deliveredAt` carries no offset, and
 * that a REJECTD row still reports a `deliveredAt`.
 */
const REPORTS = {
  delivered: `<?xml version="1.0" encoding="UTF-8"?><smsLog><logStatus>Valid</logStatus><sms><smsMeta><smsFrom>STMSG</smsFrom><smsTo>916296362154</smsTo><smsDate>2026-08-07</smsDate><creditsCharged>1</creditsCharged><messageBody>Your StyleBasket OTP is 893827. Do not share this code with anyone. Powered by Start Messaging.</messageBody></smsMeta><smsStatus><sentAt>2026-08-07 15:45:54</sentAt><deliveredAt>2026-08-07 15:45:55</deliveredAt><statusDesc>DELIVERED</statusDesc><statusId>0</statusId><statusGroupId>0</statusGroupId></smsStatus><smsError><errorId>0</errorId><errorGroupId>1</errorGroupId><isPermanent>NA</isPermanent></smsError></sms></smsLog>`,

  rejected: `<?xml version="1.0" encoding="UTF-8"?><smsLog><logStatus>Valid</logStatus><sms><smsMeta><smsFrom>STMSG</smsFrom><smsTo>918170004443</smsTo><smsDate>2026-08-07</smsDate><creditsCharged>1</creditsCharged><messageBody>Your Palash Saree Kunja OTP is 724717. Do not share this code with anyone. Powered by Start Messaging.</messageBody></smsMeta><smsStatus><sentAt>2026-08-07 16:09:23</sentAt><deliveredAt>2026-08-07 16:09:26</deliveredAt><statusDesc>REJECTD</statusDesc><statusId>0</statusId><statusGroupId>0</statusGroupId></smsStatus><smsError><errorId>633</errorId><errorGroupId>2</errorGroupId><isPermanent>NA</isPermanent></smsError></sms></smsLog>`,

  barred: `<?xml version="1.0" encoding="UTF-8"?><smsLog><logStatus>Valid</logStatus><sms><smsMeta><smsFrom>STMSG</smsFrom><smsTo>919046952792</smsTo><smsDate>2026-08-07</smsDate><creditsCharged>1</creditsCharged><messageBody>Your Palash Saree Kunja OTP is 916379. Do not share this code with anyone. Powered by Start Messaging.</messageBody></smsMeta><smsStatus><sentAt>2026-08-07 16:16:22</sentAt><deliveredAt>2026-08-07 16:16:23</deliveredAt><statusDesc>FAILED(BARRED)</statusDesc><statusId></statusId><statusGroupId></statusGroupId></smsStatus><smsError><errorId>154</errorId><errorGroupId>1</errorGroupId><isPermanent></isPermanent></smsError></sms></smsLog>`,

  // What an OTP-endpoint (msj…) session id returns — it is not in this index.
  invalid: `<?xml version="1.0" encoding="UTF-8"?><smsLog><logStatus>Invalid</logStatus></smsLog>`,
};

/**
 * The parser is private and pure, and constructing the provider would drag in
 * ConfigService for no benefit, so it is called on a bare prototype.
 */
type ParserAccess = { parseTsmsReport(xml: string): DlrResult };

function parse(xml: string): DlrResult {
  const provider = Object.create(TwoFactorProvider.prototype) as ParserAccess;
  return provider.parseTsmsReport(xml);
}

describe('TwoFactorProvider report parsing', () => {
  it('reads a delivered report and converts its IST stamp to UTC', () => {
    const dlr = parse(REPORTS.delivered);

    expect(dlr.status).toBe('delivered');
    expect(dlr.senderId).toBe('STMSG');
    expect(dlr.smsCount).toBe(1);
    // 15:45:55 IST is 10:15:55 UTC. Read as server-local on a UTC box it would
    // land 5.5 hours in the future, which is what makes this worth asserting.
    expect(dlr.deliveredAt?.toISOString()).toBe('2026-08-07T10:15:55.000Z');
  });

  it('treats REJECTD as failed and explains the DLT rejection', () => {
    const dlr = parse(REPORTS.rejected);

    expect(dlr.status).toBe('failed');
    expect(dlr.rawResponse.errorId).toBe('633');
    // A rejected message still carries a deliveredAt; it must not be recorded
    // as a delivery time, or a failed row looks delivered in the history.
    expect(dlr.deliveredAt).toBeUndefined();
  });

  it('treats FAILED(BARRED) as failed with the barring explanation', () => {
    const dlr = parse(REPORTS.barred);

    expect(dlr.status).toBe('failed');
    expect(dlr.failureReason).toContain('barring');
  });

  it('leaves failureReason unset on a delivered report', () => {
    expect(parse(REPORTS.delivered).failureReason).toBeUndefined();
  });

  it('returns unknown for a session id the report does not index', () => {
    const dlr = parse(REPORTS.invalid);

    // Must be `unknown`, not `failed`: OTP-endpoint messages answer this way
    // and are resolved by webhook. Calling them failed would wrongly finalise
    // a live message and permanently skip its delivery debit.
    expect(dlr.status).toBe('unknown');
    expect(dlr.deliveredAt).toBeUndefined();
  });

  it('does not let a 000 error code override an explicit failure status', () => {
    const contradictory = REPORTS.delivered.replace(
      '<statusDesc>DELIVERED</statusDesc>',
      '<statusDesc>FAILED</statusDesc>',
    );

    expect(parse(contradictory).status).toBe('failed');
  });
});

describe('parseIstTimestamp', () => {
  it('shifts IST to UTC', () => {
    expect(parseIstTimestamp('2026-08-07 16:09:26')?.toISOString()).toBe(
      '2026-08-07T10:39:26.000Z',
    );
  });

  it('returns null rather than an Invalid Date for junk', () => {
    expect(parseIstTimestamp('')).toBeNull();
    expect(parseIstTimestamp(null)).toBeNull();
    expect(parseIstTimestamp('not a date')).toBeNull();
  });
});
