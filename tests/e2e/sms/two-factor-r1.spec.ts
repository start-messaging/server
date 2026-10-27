import { test, expect } from '@playwright/test';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { TwoFactorProvider } from '../../../src/sms-providers/providers/two-factor.provider.js';
import {
  countTemplateSlots,
  extractTemplateVariables,
} from '../../../src/sms-providers/providers/two-factor-template.js';

/**
 * Sending multi-variable templates through 2Factor's R1 endpoint.
 *
 * This replaced the older TSMS endpoint after 2Factor asked for the move. The
 * provider is run for real here against a local stub of 2Factor, so what is
 * asserted is the exact request that would leave the building: which endpoint,
 * which parameters, in what form — and, as much, the cases where nothing must
 * leave at all.
 */

// The DLT-approved texts, exactly as the DLT portal lists them.
const DLT = {
  OTP: 'Your OTP is {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  APPNAME:
    'Your {#var#} OTP is {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  EXPIRY:
    'Your OTP is {#var#}, valid for {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
  APPNAME_EXPIRY:
    'Your {#var#} OTP is {#var#}, valid for {#var#}. Do not share this code with anyone. Powered by Start Messaging.',
};

test.describe('2Factor R1: reading template variables out of a message', () => {
  test('the approved texts and what they are filled with', () => {
    expect(
      extractTemplateVariables(
        DLT.APPNAME,
        'Your Acme OTP is 123456. Do not share this code with anyone. Powered by Start Messaging.',
      ),
    ).toEqual(['Acme', '123456']);
    expect(
      extractTemplateVariables(
        DLT.APPNAME_EXPIRY,
        'Your Acme OTP is 123456, valid for 5 minutes. Do not share this code with anyone. Powered by Start Messaging.',
      ),
    ).toEqual(['Acme', '123456', '5 minutes']);
    expect(countTemplateSlots(DLT.APPNAME_EXPIRY)).toBe(3);
  });

  test('a slot can hold more than one of our placeholders', () => {
    // The point of matching on text: DLT's second slot is "5 minutes", while our
    // own template puts "minutes" outside the placeholder. Mapping placeholders
    // to slots one for one would send "5" and change the wording.
    expect(
      extractTemplateVariables(
        DLT.EXPIRY,
        'Your OTP is 654321, valid for 5 minutes. Do not share this code with anyone. Powered by Start Messaging.',
      ),
    ).toEqual(['654321', '5 minutes']);
  });

  test('2Factor-style #VAR1# markers read the same as {#var#}', () => {
    expect(
      extractTemplateVariables(
        'Your #VAR1# OTP is #VAR2#. Do not share this code with anyone. Powered by Start Messaging.',
        'Your Acme OTP is 123456. Do not share this code with anyone. Powered by Start Messaging.',
      ),
    ).toEqual(['Acme', '123456']);
  });

  test('a message that is not an instance of the template is not matched', () => {
    for (const rendered of [
      'Your OTP is 123456. Do not share this code with anyone.',
      'Hello Acme, your code is 123456.',
      'Your Acme OTP is 123456. Do not share this code with anyone. Powered by Start Messaging. Extra.',
      '',
    ]) {
      expect(extractTemplateVariables(DLT.APPNAME, rendered), rendered).toBeNull();
    }
  });

  test('text that looks like regex is matched literally, and whitespace is not significant', () => {
    expect(
      extractTemplateVariables('Pay (₹{#var#}) now. [ref: {#var#}]', 'Pay (₹  99.50)\n now.  [ref: A.B*C]'),
    ).toEqual(['99.50', 'A.B*C']);
    // The dots and brackets in the template are not wildcards.
    expect(extractTemplateVariables('a.b {#var#}', 'axb 1')).toBeNull();
  });

  test('a template with no slots matches only an identical message', () => {
    expect(extractTemplateVariables('Hello there.', 'Hello there.')).toEqual([]);
    expect(extractTemplateVariables('Hello there.', 'Hello there!')).toBeNull();
  });
});

interface Hit {
  path: string;
  query: Record<string, string>;
}

test.describe('2Factor R1: the request the provider sends', () => {
  let server: Server;
  let hits: Hit[];
  let reply: { status: number; body: unknown };
  let origin: string;

  test.beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      hits.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
      });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test.beforeEach(() => {
    hits = [];
    reply = { status: 200, body: { Status: 'Success', Details: 'session-abc' } };
  });

  const provider = (over: Record<string, string | undefined> = {}) => {
    const values: Record<string, string | undefined> = {
      'sms.twoFactor.apiKey': 'test-api-key',
      'sms.twoFactor.senderId': 'STMSG',
      'sms.twoFactor.peId': '1101494910000093058',
      'sms.twoFactor.r1Url': `${origin}/API/R1/`,
      'sms.twoFactor.v1Url': `${origin}/API/V1`,
      ...over,
    };
    return new TwoFactorProvider({
      get: (k: string) => values[k],
    } as unknown as ConfigService);
  };

  const ids = (over: Record<string, string | undefined> = {}) =>
    ({
      '2factor': 'OTP_WITH_APPNAME_EXPIRY',
      '2factor_ctid': '1107178040840345992',
      '2factor_dlt_text': DLT.APPNAME_EXPIRY,
      ...over,
    }) as Record<string, string>;

  const MESSAGE =
    'Your Acme OTP is 123456, valid for 5 minutes. Do not share this code with anyone. Powered by Start Messaging.';

  test('a multi-variable send is one R1 request, by template name and numbered variables', async () => {
    const result = await provider().sendSms({
      to: '9034036898',
      content: MESSAGE,
      templateIdentifiers: ids(),
      multiVariable: true,
    });

    expect(result).toEqual({ providerMsgId: 'session-abc', status: 'sent' });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/API/R1/');
    expect(hits[0].query).toEqual({
      module: 'TRANS_SMS',
      apikey: 'test-api-key',
      to: '9034036898',
      from: 'STMSG',
      templatename: 'OTP_WITH_APPNAME_EXPIRY',
      var1: 'Acme',
      var2: '123456',
      var3: '5 minutes',
      peid: '1101494910000093058',
      ctid: '1107178040840345992',
    });
    // Not the rendered text: that is what the older endpoint took, and what
    // produced "Missing template name value".
    expect(hits[0].query).not.toHaveProperty('msg');
  });

  test('values with characters that mean something in a URL arrive intact', async () => {
    const tricky = 'A&B=C+D #1 ü%20';
    const content = MESSAGE.replace('Acme', tricky);
    const result = await provider().sendSms({
      to: '9034036898',
      content,
      templateIdentifiers: ids(),
      multiVariable: true,
    });
    expect(result.status).toBe('sent');
    expect(hits[0].query.var1).toBe(tricky);
    expect(hits[0].query.var2).toBe('123456');
    expect(hits[0].query.var3).toBe('5 minutes');
  });

  test("the vendor's refusal is a failed send that carries the vendor's reason", async () => {
    reply = { status: 200, body: { Status: 'Error', Details: 'DLT-CNT-REJECT' } };
    const result = await provider().sendSms({
      to: '9034036898',
      content: MESSAGE,
      templateIdentifiers: ids(),
      multiVariable: true,
    });
    expect(result.status).toBe('failed');
    expect(result.errorType).toBe('service');
    expect(result.providerFailureReason).toBe('DLT-CNT-REJECT');
    // The customer-facing reason never names the vendor's wording.
    expect(result.failureReason).not.toContain('DLT');
    expect(hits).toHaveLength(1);
  });

  test('an HTTP error is a failed send, and the API key is not in the reason', async () => {
    reply = { status: 500, body: { Status: 'Error', Details: 'node down' } };
    const result = await provider().sendSms({
      to: '9034036898',
      content: MESSAGE,
      templateIdentifiers: ids(),
      multiVariable: true,
    });
    expect(result.status).toBe('failed');
    expect(result.providerFailureReason).toBe('node down');
    expect(JSON.stringify(result)).not.toContain('test-api-key');
  });

  test('anything the template or account is missing is refused before any request', async () => {
    const cases: [string, Record<string, string | undefined>, Record<string, string | undefined>, RegExp][] = [
      ['no PE ID', { 'sms.twoFactor.peId': '' }, {}, /TWOFACTOR_PE_ID/],
      ['no template name', {}, { '2factor': undefined }, /template name/],
      ['no DLT template id', {}, { '2factor_ctid': undefined }, /2factor_ctid/],
      ['no DLT text', {}, { '2factor_dlt_text': undefined }, /2factor_dlt_text/],
    ];
    for (const [label, cfg, meta, reason] of cases) {
      const result = await provider(cfg).sendSms({
        to: '9034036898',
        content: MESSAGE,
        templateIdentifiers: ids(meta),
        multiVariable: true,
      });
      expect(result.status, label).toBe('failed');
      // A validation failure: retrying or trying another provider cannot fix it.
      expect(result.errorType, label).toBe('validation');
      expect(result.providerFailureReason, label).toMatch(reason);
    }
    expect(hits, 'something was sent despite a missing piece').toHaveLength(0);
  });

  test('a message that does not match the approved text is refused, not sent to be rejected', async () => {
    const result = await provider().sendSms({
      to: '9034036898',
      content: 'Your Acme code is 123456.',
      templateIdentifiers: ids(),
      multiVariable: true,
    });
    expect(result.status).toBe('failed');
    expect(result.errorType).toBe('validation');
    expect(result.providerFailureReason).toMatch(/does not match its approved DLT text/);
    expect(hits).toHaveLength(0);
  });

  test('a single-variable OTP still goes through the OTP endpoint, not R1', async () => {
    const result = await provider().sendSms({
      to: '9034036898',
      content: 'Your OTP is 123456. Do not share this code with anyone. Powered by Start Messaging.',
      templateIdentifiers: { '2factor': 'OTP' },
    });
    expect(result.status).toBe('sent');
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/API/V1/test-api-key/SMS/9034036898/123456/OTP');
  });
});

test.describe('2Factor: never a real provider in a test run', () => {
  test('a configured key does not make the provider healthy when NODE_ENV is test', async () => {
    // Regression: a real key in a developer .env made the full e2e run send real
    // OTPs to the suite's fake numbers. The provider must refuse regardless of
    // what is configured.
    const provider = new TwoFactorProvider({
      get: (k: string) => (k === 'sms.twoFactor.apiKey' ? 'a-real-looking-key' : undefined),
    } as unknown as ConfigService);

    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      expect(await provider.isHealthy()).toBe(false);
      process.env.NODE_ENV = 'production';
      expect(await provider.isHealthy()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});
