import { Controller, Get, Logger, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { Public } from '../../common/decorators/public.decorator.js';
import { OutreachService } from './outreach.service.js';
import { CLICK_HOSTS_CSV } from './outreach.constant.js';

/** A 1×1 transparent GIF — the smallest thing a mail client will render. */
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * First-party open/click/unsubscribe tracking for outreach emails.
 *
 * Every route is public (a mail client carries no JWT) and every route
 * answers pleasantly for unknown tokens — an error page here is shown to a
 * human who clicked a link in an email, and a distinguishable response would
 * make the endpoints an oracle for guessing valid tokens.
 *
 * All routes use @Res() raw responses: the global TransformResponseInterceptor
 * would otherwise wrap the pixel Buffer (and the unsubscribe HTML) in the
 * JSON envelope, and a mail client cannot render `{"success":true,...}` as
 * an image.
 */
@ApiTags('Outreach tracking')
@Controller('t')
export class OutreachTrackingController {
  private readonly logger = new Logger(OutreachTrackingController.name);

  constructor(
    private readonly outreach: OutreachService,
    private readonly config: ConfigService,
  ) {}

  @Get('o/:token')
  @Public()
  trackOpen(@Param('token') token: string, @Res() res: Response): void {
    // Fire-and-forget: the pixel must return instantly whatever the database
    // is doing — mail clients time out slow images and some retry them.
    void this.outreach.handleOpen(token).catch((err: Error) => {
      this.logger.warn(`open tracking failed: ${err.message}`);
    });

    res
      .status(200)
      .setHeader('Content-Type', 'image/gif')
      .setHeader('Cache-Control', 'no-store, max-age=0')
      .end(PIXEL_GIF);
  }

  @Get('c/:token')
  @Public()
  trackClick(
    @Param('token') token: string,
    @Query('u') u: string | undefined,
    @Res() res: Response,
  ): void {
    const fallback =
      this.config.get<string>('outreach.linkBaseUrl') ??
      'https://startmessaging.com';

    // The redirect target must be one of ours. `u` is attacker-writable —
    // anyone can mint /t/c/<junk>?u=https://evil.example — and forwarding to
    // a foreign host would make this an open redirect wearing our domain.
    let target = fallback;
    if (u) {
      try {
        const parsed = new URL(u);
        const allowed = new Set(
          CLICK_HOSTS_CSV.split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean),
        );
        if (allowed.has(parsed.hostname.toLowerCase())) {
          target = u;
        }
      } catch {
        // Unparseable u → fall through to the marketing site.
      }
    }

    // Unknown tokens still redirect: the person who clicked gets the site,
    // never an error page.
    void this.outreach.handleClick(token, target).catch((err: Error) => {
      this.logger.warn(`click tracking failed: ${err.message}`);
    });

    res.redirect(302, target);
  }

  @Get('u/:token')
  @Public()
  async unsubscribePage(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.outreach.handleUnsubscribe(token).catch((err: Error) => {
      this.logger.warn(`unsubscribe failed: ${err.message}`);
      return null;
    });

    // 200 with the same copy even for unknown tokens: the person clicked
    // "unsubscribe" and the only acceptable answer is that it worked.
    res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title></head>` +
          `<body style="font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;">` +
          `<p style="font-size:16px;color:#222;max-width:26em;text-align:center;">You've been unsubscribed — you won't hear from us again.</p>` +
          `</body></html>`,
      );
  }

  /** RFC 8058 one-click unsubscribe — mail clients POST here, no body needed. */
  @Post('u/:token')
  @Public()
  async unsubscribeOneClick(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.outreach.handleUnsubscribe(token).catch((err: Error) => {
      this.logger.warn(`one-click unsubscribe failed: ${err.message}`);
      return null;
    });
    res.status(200).json({});
  }
}
