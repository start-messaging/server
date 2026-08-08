import { ConfigService } from '@nestjs/config';
import { EmailTrackingService } from './email-tracking.service.js';

const SECRET = 'a'.repeat(48);
const BASE = 'https://mail.example.com';

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'campaigns.trackingBaseUrl': BASE,
    'campaigns.trackingSecret': SECRET,
    ...overrides,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new EmailTrackingService(config);
}

/** Pulls the three path segments out of a click URL. */
function splitClickUrl(url: string) {
  const [recipientId, encodedUrl, sig] = url
    .replace(`${BASE}/e/c/`, '')
    .split('/');
  return { recipientId, encodedUrl, sig };
}

describe('EmailTrackingService', () => {
  const recipientId = '11111111-2222-3333-4444-555555555555';

  describe('open tokens', () => {
    it('round-trips a token it minted', () => {
      const service = makeService();
      const url = service.openPixelUrl(recipientId);
      const token = url.replace(`${BASE}/e/o/`, '');

      expect(service.verifyOpen(token)).toBe(recipientId);
    });

    it('rejects a token for a different recipient', () => {
      const service = makeService();
      const url = service.openPixelUrl(recipientId);
      const token = url.replace(`${BASE}/e/o/`, '');
      const sig = token.split('.').pop();

      // Swapping the id while keeping a valid signature is the obvious attack:
      // it would let anyone walk the recipient table by guessing uuids.
      expect(service.verifyOpen(`99999999-9999-9999-9999-999999999999.${sig}`))
        .toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
      const minted = makeService().openPixelUrl(recipientId);
      const token = minted.replace(`${BASE}/e/o/`, '');

      const other = makeService({ 'campaigns.trackingSecret': 'b'.repeat(48) });
      expect(other.verifyOpen(token)).toBeNull();
    });

    it('rejects everything when no secret is configured', () => {
      const service = makeService({ 'campaigns.trackingSecret': undefined });
      expect(service.verifyOpen(`${recipientId}.anything`)).toBeNull();
    });

    it('tolerates the .gif suffix the pixel URL carries', () => {
      const service = makeService();
      const url = service.openPixelUrl(recipientId);
      expect(url.endsWith('.gif')).toBe(true);
      expect(service.verifyOpen(url.replace(`${BASE}/e/o/`, ''))).toBe(
        recipientId,
      );
    });
  });

  describe('click tokens', () => {
    const target = 'https://startmessaging.com/pricing?utm=cold';

    it('round-trips the destination', () => {
      const service = makeService();
      const { recipientId: rid, encodedUrl, sig } = splitClickUrl(
        service.clickUrl(recipientId, target),
      );

      expect(service.verifyClick(rid, encodedUrl, sig)).toEqual({
        recipientId,
        url: target,
      });
    });

    it('refuses a destination swapped after signing', () => {
      const service = makeService();
      const { recipientId: rid, sig } = splitClickUrl(
        service.clickUrl(recipientId, target),
      );

      // The whole reason the URL is inside the signature: without it this
      // endpoint is an open redirect on the domain that sends our mail, which
      // is an ideal host for a phishing link.
      const evil = Buffer.from('https://phishing.example/login')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(service.verifyClick(rid, evil, sig)).toBeNull();
    });

    it('refuses a non-http destination even when correctly signed', () => {
      const service = makeService();
      const { recipientId: rid, encodedUrl, sig } = splitClickUrl(
        service.clickUrl(recipientId, 'javascript:alert(1)'),
      );

      expect(service.verifyClick(rid, encodedUrl, sig)).toBeNull();
    });
  });

  describe('purpose separation', () => {
    it('will not accept an open token as an unsubscribe token', () => {
      const service = makeService();
      const openToken = service
        .openPixelUrl(recipientId)
        .replace(`${BASE}/e/o/`, '')
        .replace(/\.gif$/, '');
      const openSig = openToken.split('.').pop() as string;

      // Every delivered email contains a pixel URL, and mail clients fetch it
      // automatically. If one signature worked for both purposes, that pixel
      // would double as a working unsubscribe link for the recipient.
      expect(service.verifyUnsubscribe(recipientId, openSig)).toBeNull();
    });

    it('round-trips an unsubscribe token', () => {
      const service = makeService();
      const url = service.unsubscribeUrl(recipientId);
      const [, sig] = url.replace(`${BASE}/e/u/`, '').split('/');

      expect(service.verifyUnsubscribe(recipientId, sig)).toBe(recipientId);
    });
  });

  describe('instrumentHtml', () => {
    it('rewrites links and appends the pixel before </body>', () => {
      const service = makeService();
      const html =
        '<html><body><p><a href="https://startmessaging.com">Visit</a></p></body></html>';

      const out = service.instrumentHtml(html, recipientId, {
        trackOpens: true,
        trackClicks: true,
      });

      expect(out).toContain(`${BASE}/e/c/${recipientId}/`);
      expect(out).not.toContain('href="https://startmessaging.com"');
      // Markup after </body> is discarded by some clients, which would zero
      // the open rate for those recipients.
      expect(out.indexOf(`${BASE}/e/o/`)).toBeLessThan(out.indexOf('</body>'));
    });

    it('leaves mailto, tel and anchor links alone', () => {
      const service = makeService();
      const html =
        '<a href="mailto:hi@x.com">mail</a><a href="tel:+911234">call</a><a href="#top">top</a>';

      const out = service.instrumentHtml(html, recipientId, {
        trackOpens: false,
        trackClicks: true,
      });

      expect(out).toBe(html);
    });

    it('does not rewrite its own tracking links', () => {
      const service = makeService();
      const unsubscribe = service.unsubscribeUrl(recipientId);
      const html = `<a href="${unsubscribe}">Unsubscribe</a>`;

      const out = service.instrumentHtml(html, recipientId, {
        trackOpens: false,
        trackClicks: true,
      });

      // Someone leaving is not engagement, and nesting a token inside a token
      // would break the unsubscribe entirely.
      expect(out).toBe(html);
    });

    it('honours tracking being switched off', () => {
      const service = makeService();
      const html = '<body><a href="https://x.com">x</a></body>';

      const out = service.instrumentHtml(html, recipientId, {
        trackOpens: false,
        trackClicks: false,
      });

      expect(out).toBe(html);
    });
  });
});
