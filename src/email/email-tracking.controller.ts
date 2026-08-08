import {
  Controller,
  Get,
  Head,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { EmailEventType } from './entities/email-event.entity.js';
import { EmailCampaignsService } from './services/email-campaigns.service.js';
import { EmailTrackingService } from './services/email-tracking.service.js';
import { describeUserAgent } from './utils/user-agent.util.js';

/**
 * The endpoints embedded in delivered email.
 *
 * Public and unauthenticated by necessity — they are fetched by mail clients,
 * not by a signed-in browser — so every one of them is guarded by an HMAC in
 * the path instead. Throttling is skipped because a single campaign produces a
 * burst of pixel hits the moment it lands, and rate-limiting those would
 * silently discard exactly the data the feature exists to collect.
 *
 * Nothing here returns anything about the recipient. An attacker holding a
 * forwarded email already has its contents; these must not additionally
 * disclose whether an address is on a list, which is why an invalid token
 * returns the same pixel as a valid one.
 */
@ApiExcludeController()
@Controller('e')
export class EmailTrackingController {
  constructor(
    private readonly tracking: EmailTrackingService,
    private readonly campaigns: EmailCampaignsService,
  ) {}

  /**
   * Open pixel.
   *
   * Always 200s with an image, token valid or not. Returning 404 for a bad
   * token would turn this into an oracle for which tracking links are live, and
   * would show a broken-image icon in the recipient's email.
   */
  @Get('o/:token')
  @Public()
  @SkipThrottle()
  async open(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const recipientId = this.tracking.verifyOpen(token);

    if (recipientId) {
      const ua = req.get('user-agent') ?? '';
      await this.campaigns
        .recordEvent({
          recipientId,
          event: EmailEventType.OPENED,
          ip: this.clientIp(req),
          userAgentMeta: describeUserAgent(ua),
          raw: { userAgent: ua },
        })
        // A failure to record must never break the image response; the
        // recipient would see a broken image in an email we sent them.
        .catch(() => undefined);
    }

    this.sendPixel(res);
  }

  /**
   * Some clients issue a HEAD before fetching an image.
   *
   * Answered without recording anything: a HEAD is the client deciding whether
   * to load the image, not a human having read the mail.
   */
  @Head('o/:token')
  @Public()
  @SkipThrottle()
  headOpen(@Res() res: Response): void {
    this.sendPixel(res);
  }

  /**
   * Click redirect.
   *
   * The destination is carried in the signed token rather than a query
   * parameter, so this can never be turned into an open redirect on a domain
   * that also sends our mail.
   */
  @Get('c/:recipientId/:encodedUrl/:sig')
  @Public()
  @SkipThrottle()
  async click(
    @Param('recipientId') recipientId: string,
    @Param('encodedUrl') encodedUrl: string,
    @Param('sig') sig: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const payload = this.tracking.verifyClick(recipientId, encodedUrl, sig);

    if (!payload) {
      res.status(HttpStatus.BAD_REQUEST).send('This link is no longer valid.');
      return;
    }

    const ua = req.get('user-agent') ?? '';
    await this.campaigns
      .recordEvent({
        recipientId: payload.recipientId,
        event: EmailEventType.CLICKED,
        url: payload.url,
        ip: this.clientIp(req),
        userAgentMeta: describeUserAgent(ua),
        raw: { userAgent: ua },
      })
      // The redirect matters more than the analytics: a recipient who clicked a
      // link in our email must reach the page even if our database is down.
      .catch(() => undefined);

    // 302 rather than 301. A permanent redirect is cached by the browser, so
    // the recipient's second click would never reach us and would go
    // uncounted.
    res.redirect(HttpStatus.FOUND, payload.url);
  }

  /**
   * The unsubscribe page.
   *
   * Deliberately does NOT unsubscribe on GET. Mail clients, corporate link
   * scanners and preview services all fetch links in received mail
   * automatically — an action on GET would unsubscribe people who never
   * touched it. The page posts to the same URL to confirm.
   */
  @Get('u/:recipientId/:sig')
  @Public()
  @SkipThrottle()
  unsubscribePage(
    @Param('recipientId') recipientId: string,
    @Param('sig') sig: string,
    @Res() res: Response,
  ): void {
    const valid = this.tracking.verifyUnsubscribe(recipientId, sig);

    res
      .status(valid ? HttpStatus.OK : HttpStatus.BAD_REQUEST)
      .type('html')
      .send(
        valid
          ? this.page(
              'Unsubscribe',
              `<p>Click below and you will not receive marketing email from us again.</p>
               <form method="post" action="">
                 <button type="submit">Unsubscribe me</button>
               </form>`,
            )
          : this.page(
              'Link expired',
              '<p>This unsubscribe link is not valid. Reply to any of our emails and we will remove you.</p>',
            ),
      );
  }

  /**
   * One-click unsubscribe.
   *
   * Serves both the confirmation form above and RFC 8058, which is what Gmail
   * and Yahoo POST to when the recipient uses their built-in unsubscribe
   * button. Both routes must work, and both must be idempotent.
   */
  @Post('u/:recipientId/:sig')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async unsubscribe(
    @Param('recipientId') recipientId: string,
    @Param('sig') sig: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const valid = this.tracking.verifyUnsubscribe(recipientId, sig);

    if (!valid) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .type('html')
        .send(this.page('Link expired', '<p>This link is not valid.</p>'));
      return;
    }

    await this.campaigns.recordEvent({
      recipientId,
      event: EmailEventType.UNSUBSCRIBED,
      ip: this.clientIp(req),
      userAgentMeta: describeUserAgent(req.get('user-agent') ?? ''),
    });

    res
      .type('html')
      .send(
        this.page(
          'Unsubscribed',
          '<p>Done — you will not receive marketing email from us again.</p>',
        ),
      );
  }

  private sendPixel(res: Response): void {
    res
      .status(HttpStatus.OK)
      .set({
        'Content-Type': 'image/gif',
        // Without this the client, or Gmail's image proxy, serves the second
        // open from cache and every open after the first goes unrecorded.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
        Expires: '0',
      })
      .send(EmailTrackingService.PIXEL_GIF);
  }

  /**
   * Best-effort client IP.
   *
   * Rarely the recipient's own: Gmail proxies images through Google's servers,
   * so an open recorded from a googleusercontent address says only that Gmail
   * fetched it. Stored for support questions, never used to identify anyone.
   */
  private clientIp(req: Request): string | null {
    const forwarded = req.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.ip ?? null;
  }

  private page(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f6f8;margin:0;padding:48px 16px;color:#1f2937;}
  .card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;}
  h1{font-size:20px;margin:0 0 12px;}
  p{font-size:15px;line-height:1.6;color:#4b5563;margin:0 0 16px;}
  button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer;}
</style>
</head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
  }
}
