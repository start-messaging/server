import { ConfigService } from '@nestjs/config';
import { EmailRenderService } from './email-render.service.js';

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'campaigns.fromName': 'StartMessaging',
    'campaigns.companyAddress': '12 MG Road, Bengaluru 560001',
    ...overrides,
  };
  return new EmailRenderService({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

const UNSUB = 'https://mail.example.com/e/u/abc/def';

describe('EmailRenderService', () => {
  describe('substitute', () => {
    it('fills merge fields from the recipient', () => {
      const service = makeService();
      const out = service.substitute(
        'Hi {{firstName}} at {{companyName}}',
        { email: 'r@acme.in', firstName: 'Ravi', companyName: 'Acme' },
        { escape: true },
      );
      expect(out).toBe('Hi Ravi at Acme');
    });

    it('uses the fallback when a value is missing', () => {
      const service = makeService();
      const out = service.substitute(
        'Hi {{firstName|there}},',
        { email: 'r@acme.in' },
        { escape: true },
      );
      // "Hi ," at the top of a cold email announces that it was blasted, and
      // half a pasted lead list has no name attached.
      expect(out).toBe('Hi there,');
    });

    it('treats an empty string as missing', () => {
      const service = makeService();
      const out = service.substitute(
        '{{firstName|friend}}',
        { email: 'r@acme.in', firstName: '' },
        { escape: true },
      );
      expect(out).toBe('friend');
    });

    it('builds fullName from both halves', () => {
      const service = makeService();
      const out = service.substitute(
        '{{fullName}}',
        { email: 'r@acme.in', firstName: 'Ravi', lastName: 'Sharma' },
        { escape: false },
      );
      expect(out).toBe('Ravi Sharma');
    });

    it('escapes HTML in substituted values', () => {
      const service = makeService();
      const out = service.substitute(
        'Hi {{firstName}}',
        { email: 'r@acme.in', firstName: '<script>alert(1)</script>' },
        { escape: true },
      );
      // Names arrive from customer signup and pasted lead lists; neither has
      // been reviewed by anyone.
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
    });

    it('leaves an unknown token with no fallback empty', () => {
      const service = makeService();
      expect(
        service.substitute('[{{nope}}]', { email: 'r@acme.in' }, { escape: true }),
      ).toBe('[]');
    });
  });

  describe('render', () => {
    it('strips newlines from the subject', () => {
      const service = makeService();
      const { subject } = service.render(
        { subject: 'Hello {{firstName}}', bodyHtml: '<p>hi</p>' },
        { email: 'r@acme.in', firstName: 'Ravi\r\nBcc: victim@example.com' },
        UNSUB,
      );

      // A merge value carrying CRLF into a mail header is header injection.
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject).toContain('Ravi');
    });

    it('includes the unsubscribe link and postal address in the footer', () => {
      const service = makeService();
      const { html } = service.render(
        { subject: 's', bodyHtml: '<p>body</p>' },
        { email: 'r@acme.in' },
        UNSUB,
      );

      expect(html).toContain(UNSUB);
      expect(html).toContain('12 MG Road, Bengaluru 560001');
    });

    it('omits the address block when none is configured', () => {
      const service = makeService({ 'campaigns.companyAddress': undefined });
      const { html } = service.render(
        { subject: 's', bodyHtml: '<p>body</p>' },
        { email: 'r@acme.in' },
        UNSUB,
      );

      expect(html).toContain(UNSUB);
      expect(html).not.toContain('MG Road');
    });

    it('hides the preheader from the visible body', () => {
      const service = makeService();
      const { html } = service.render(
        { subject: 's', bodyHtml: '<p>body</p>', preheader: 'Quick question' },
        { email: 'r@acme.in' },
        UNSUB,
      );

      expect(html).toContain('Quick question');
      expect(html).toContain('display:none');
    });

    it('always produces a plain-text alternative', () => {
      const service = makeService();
      const { text } = service.render(
        {
          subject: 's',
          bodyHtml: '<p>Hello there</p><a href="https://x.com/a">our pricing</a>',
        },
        { email: 'r@acme.in' },
        UNSUB,
      );

      expect(text).toContain('Hello there');
      // The text part has to carry the call to action too, not drop it.
      expect(text).toContain('our pricing (https://x.com/a)');
      expect(text).toContain(UNSUB);
      expect(text).not.toContain('<p>');
    });
  });

  describe('toPlainText', () => {
    it('does not print a bare URL twice', () => {
      const service = makeService();
      const text = service.toPlainText(
        '<a href="https://x.com/a">https://x.com/a</a>',
      );
      expect(text).toBe('https://x.com/a');
    });

    it('turns list items into dashes', () => {
      const service = makeService();
      const text = service.toPlainText('<ul><li>one</li><li>two</li></ul>');
      expect(text).toContain('- one');
      expect(text).toContain('- two');
    });

    it('drops script and style blocks entirely', () => {
      const service = makeService();
      const text = service.toPlainText(
        '<style>p{color:red}</style><script>evil()</script><p>real</p>',
      );
      expect(text).toBe('real');
    });
  });
});
