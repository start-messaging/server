import { Lead } from '../entities/lead.entity.js';

export interface OutreachEmailInput {
  lead: Lead;
  /** Where the pixel/click/unsubscribe endpoints live — this API. */
  trackingBaseUrl: string;
  /** The CTA target — the marketing site. */
  linkBaseUrl: string;
  fromName: string;
  /** CAN-SPAM postal address; rendered only when non-empty. */
  postalAddress: string;
  subjectOverride?: string;
  bodyHtmlOverride?: string;
}

export interface OutreachEmail {
  subject: string;
  html: string;
  text: string;
}

/** Site titles come from strangers' HTML; anything interpolated is escaped. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders one cold-outreach email.
 *
 * Short, honest and lightly styled on purpose — this has to read like a
 * person wrote it, because it is competing with a spam folder, not with a
 * design award. The CTA runs through the click tracker with the ?smref=
 * attribution parameter so PostHog on the marketing site can weld the visit
 * to this lead.
 *
 * bodyHtmlOverride replaces the inner body only. The open pixel and the
 * footer — unsubscribe link and postal address — are ALWAYS appended: the
 * compliance footer is not optional, whatever copy an admin pastes in.
 */
export function buildOutreachEmail(input: OutreachEmailInput): OutreachEmail {
  const { lead, trackingBaseUrl, linkBaseUrl, fromName, postalAddress } = input;

  const subject = input.subjectOverride ?? `Quick question about ${lead.domain}`;

  const targetUrl = `${linkBaseUrl}/?smref=${lead.id}`;
  const clickUrl = `${trackingBaseUrl}/t/c/${lead.outreachToken}?u=${encodeURIComponent(targetUrl)}`;
  const unsubUrl = `${trackingBaseUrl}/t/u/${lead.outreachToken}`;
  const pixelUrl = `${trackingBaseUrl}/t/o/${lead.outreachToken}`;

  const siteName = lead.siteTitle?.trim() || lead.domain;

  const defaultBody = `
    <p>Hi there,</p>
    <p>I came across ${escapeHtml(siteName)} — congrats on getting the new site up.</p>
    <p>I work at StartMessaging. We build OTP and SMS verification APIs for
    Indian businesses — sign-in codes, order updates, that kind of thing —
    with WhatsApp messaging on the way.</p>
    <p>If your site will ever log users in or confirm orders, I'd love to show
    you how quickly it plugs in.</p>
    <p><a href="${clickUrl}" style="color:#1a73e8;">Take a look at StartMessaging</a></p>
    <p>Best,<br>${escapeHtml(fromName)}</p>
  `;

  const innerBody = input.bodyHtmlOverride ?? defaultBody;

  const footer = `
    <hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 12px;">
    <p style="font-size:12px;color:#888888;line-height:1.5;">
      You received this one-time note because ${escapeHtml(lead.domain)} was
      recently registered as a public domain.
      ${postalAddress ? `<br>${escapeHtml(postalAddress)}` : ''}
      <br><a href="${unsubUrl}" style="color:#888888;">Unsubscribe</a> and you
      won't hear from us again.
    </p>
  `;

  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none">`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222222;max-width:560px;line-height:1.6;">
      ${innerBody}
      ${footer}
    </div>
    ${pixel}
  `;

  const text = [
    'Hi there,',
    '',
    `I came across ${siteName} — congrats on getting the new site up.`,
    '',
    'I work at StartMessaging. We build OTP and SMS verification APIs for',
    'Indian businesses — sign-in codes, order updates, that kind of thing —',
    'with WhatsApp messaging on the way.',
    '',
    `Take a look: ${clickUrl}`,
    '',
    `Best,`,
    fromName,
    '',
    '--',
    `You received this one-time note because ${lead.domain} was recently registered as a public domain.`,
    ...(postalAddress ? [postalAddress] : []),
    `Unsubscribe: ${unsubUrl}`,
  ].join('\n');

  return { subject, html, text };
}
