import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  SmsProvider,
  SendSmsParams,
  SendSmsResult,
  DlrResult,
} from '../sms-provider.interface.js';
import {
  extractTemplateVariables,
  countTemplateSlots,
} from './two-factor-template.js';
import {
  GENERIC_FAILURE_REASON,
  TWO_FACTOR_ERROR_MAP,
  customerFacingReason,
  mapTwoFactorStatusName,
  normalizeErrorCode,
  parseIstTimestamp,
} from './two-factor-status.js';

/**
 * Every call to 2Factor is bounded.
 *
 * axios defaults to no timeout at all, so a vendor that accepts the connection
 * and then stops responding held the request until the OS gave up on the
 * socket — minutes, not seconds. Two of these three calls are made from inside
 * a customer's synchronous `POST /otp/send`, so that is a customer waiting, a
 * Node handle pinned, and — on a 2 GB box that also runs other things — a way
 * for one vendor incident to become an outage on our side of the boundary.
 *
 * The send is the tighter budget because someone is watching a form: past ten
 * seconds the OTP has failed as far as they are concerned, and failing fast
 * lets the caller retry against a provider that is answering. The report poll
 * is a background sweep with nobody waiting, so it is allowed longer before it
 * gives up and leaves the row for the next pass.
 */
const SEND_TIMEOUT_MS = 10_000;
const REPORT_TIMEOUT_MS = 20_000;

@Injectable()
export class TwoFactorProvider implements SmsProvider {
  private readonly logger = new Logger(TwoFactorProvider.name);
  private readonly apiKey: string;
  private readonly templateName: string;
  private readonly senderId: string;
  /** The DLT Principal Entity ID — the registered business, the same for every template. */
  private readonly peId: string;
  private readonly baseUrl: string;
  private readonly r1Url: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('sms.twoFactor.apiKey') ?? '';
    this.templateName =
      this.config.get<string>('sms.twoFactor.templateName') ?? 'OTP';
    this.senderId =
      this.config.get<string>('sms.twoFactor.senderId') ?? 'STMSG';
    this.peId = this.config.get<string>('sms.twoFactor.peId') ?? '';
    // The two endpoints are overridable only through config keys that
    // configuration.ts never reads from the environment, so a deployed process
    // cannot be pointed at another host (which would be handed the API key). A
    // spec that constructs this class directly sets them to a local stub.
    this.baseUrl =
      this.config.get<string>('sms.twoFactor.v1Url') ??
      'https://2factor.in/API/V1';
    this.r1Url =
      this.config.get<string>('sms.twoFactor.r1Url') ??
      'https://2factor.in/API/R1/';
  }

  get name(): string {
    return '2factor';
  }

  get priority(): number {
    return 1; // Primary provider
  }

  isHealthy(): Promise<boolean> {
    // Never a real provider in a test run, whatever keys are lying around.
    //
    // The e2e suite boots the real server, which reads `.env` for any setting
    // the test environment does not pin — and TWOFACTOR_API_KEY is not pinned,
    // because the suite is meant to run with none. So the day a real key was
    // added to a developer's `.env` (to try a live send), the next full run sent
    // 49 real OTPs to the suite's made-up numbers: six delivered to real
    // handsets, sixteen voice-call fallbacks, and credits spent. A guard that
    // depends on a file being empty is not a guard. NODE_ENV=test is set by the
    // suite and by nothing else, so the vendor is refused here: the factory then
    // falls through to the console provider, which is what the suite expects.
    if (process.env.NODE_ENV === 'test') return Promise.resolve(false);
    return Promise.resolve(!!this.apiKey);
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    // A template with more than one variable cannot be filled by the OTP
    // endpoint (it only substitutes the OTP), so 2Factor would leave the other
    // variables empty and fall back to a voice call. Those go through the R1
    // transactional endpoint, with the template name and its variables.
    if (params.multiVariable) {
      return this.sendR1(params);
    }

    const otp = this.extractOtp(params.content);
    if (!otp) {
      this.logger.error('Failed to extract OTP from content for 2Factor.in');
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: 'Could not extract numeric OTP from content',
        errorType: 'validation',
      };
    }

    // Endpoint: https://2factor.in/API/V1/{api_key}/SMS/{phone_number}/{otp_val}/{template_name}
    const templateName =
      params.templateIdentifiers?.['2factor'] || this.templateName;
    const url = `${this.baseUrl}/${this.apiKey}/SMS/${params.to}/${otp}/${templateName}`;

    try {
      this.logger.debug(`Sending 2Factor SMS to ${params.to}`);
      const response = await axios.get(url, { timeout: SEND_TIMEOUT_MS });

      if (response.data.Status === 'Success') {
        return {
          providerMsgId: response.data.Details, // Detailed session ID
          status: 'sent',
        };
      }

      // 2Factor answers HTTP 200 with Status:Error for a rejected send, so
      // this branch — not the catch below — is where real refusals land. It
      // logged nothing until 2026-08-08, which is why a fortnight of
      // "All SMS providers failed" rows have no recoverable cause.
      this.logger.error(
        `2Factor.in rejected OTP send to ${params.to}: ${JSON.stringify(response.data)}`,
      );
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: GENERIC_FAILURE_REASON,
        providerFailureReason: String(
          response.data?.Details ?? 'Unknown error',
        ),
        errorType: 'service',
      };
    } catch (error: any) {
      const errorMessage = error?.response?.data?.Details || error?.message;
      this.logger.error(`2Factor.in API Error: ${errorMessage}`);
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: GENERIC_FAILURE_REASON,
        providerFailureReason: String(errorMessage),
        errorType: 'service',
      };
    }
  }

  /**
   * Sends a DLT-approved multi-variable template through 2Factor's R1
   * transactional endpoint.
   *
   * This replaced the older TSMS endpoint (`ADDON_SERVICES/SEND/TSMS`, which
   * took the fully rendered text as `Msg`). 2Factor asked for the move after a
   * node behind that endpoint intermittently refused sends with "Missing
   * template name value": the old endpoint matches the text against a template
   * on their side, and R1 is addressed by template name instead.
   *
   * Endpoint: GET /API/R1/?module=TRANS_SMS&apikey=…&to=…&from=…
   *           &templatename=…&var1=…&var2=…&peid=…&ctid=…
   *
   * What each template needs, kept on the template's own metadata:
   *   - `2factor`            the template name registered with 2Factor;
   *   - `2factor_ctid`       its DLT Content Template ID;
   *   - `2factor_dlt_text`   the DLT-approved text with its `#VAR1#` slots.
   * plus the account-wide PE ID (TWOFACTOR_PE_ID). Anything missing is refused
   * here, before a request is made, with a reason an admin can act on — there is
   * no fallback to the old endpoint, so a gap shows up as a failed send that
   * says what is missing, not as a quiet return to the thing being retired.
   */
  private async sendR1(params: SendSmsParams): Promise<SendSmsResult> {
    const ids = params.templateIdentifiers ?? {};
    const templateName = ids['2factor'];
    const ctid = ids['2factor_ctid'];
    const dltText = ids['2factor_dlt_text'];

    const missing = [
      !this.peId && 'TWOFACTOR_PE_ID',
      !templateName && 'template name (metadata.2factor)',
      !ctid && 'DLT template id (metadata.2factor_ctid)',
      !dltText && 'DLT template text (metadata.2factor_dlt_text)',
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      return this.refuse(
        `R1 send not configured for template "${templateName ?? '?'}": missing ${missing.join(', ')}`,
      );
    }

    const values = extractTemplateVariables(dltText, params.content);
    if (!values) {
      return this.refuse(
        `The message for template "${templateName}" does not match its approved DLT text, ` +
          `so it was not sent (it would be rejected). Template slots: ${countTemplateSlots(dltText)}.`,
      );
    }

    const query = new URLSearchParams({
      module: 'TRANS_SMS',
      apikey: this.apiKey,
      to: params.to,
      from: this.senderId,
      templatename: templateName,
    });
    values.forEach((v, i) => query.set(`var${i + 1}`, v));
    query.set('peid', this.peId);
    query.set('ctid', ctid);

    try {
      this.logger.debug(
        `Sending 2Factor R1 SMS to ${params.to} (template ${templateName}, from ${this.senderId})`,
      );
      const response = await axios.get(`${this.r1Url}?${query.toString()}`, {
        timeout: SEND_TIMEOUT_MS,
      });

      if (response.data?.Status === 'Success') {
        return {
          providerMsgId: String(response.data.Details), // session id
          status: 'sent',
        };
      }

      // As in sendSms: a refusal arrives as HTTP 200 + Status:Error, so the
      // catch block never sees it, and the reason has to be recorded here.
      this.logger.error(
        `2Factor.in rejected R1 send to ${params.to} ` +
          `(template ${templateName}): ${JSON.stringify(response.data)}`,
      );
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: GENERIC_FAILURE_REASON,
        providerFailureReason: String(
          response.data?.Details ?? 'Unknown error',
        ),
        errorType: 'service',
      };
    } catch (error: any) {
      // The message only — never the request, which carries the API key.
      const errorMessage = error?.response?.data?.Details || error?.message;
      this.logger.error(`2Factor.in R1 API Error: ${errorMessage}`);
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: GENERIC_FAILURE_REASON,
        providerFailureReason: String(errorMessage),
        errorType: 'service',
      };
    }
  }

  /**
   * A send refused before any request: our own configuration or template is
   * wrong, which a retry or another provider cannot fix, so it is a
   * `validation` failure (the factory does not try a fallback for those).
   */
  private refuse(reason: string): SendSmsResult {
    this.logger.error(reason);
    return {
      providerMsgId: '',
      status: 'failed',
      failureReason: GENERIC_FAILURE_REASON,
      providerFailureReason: reason,
      errorType: 'validation',
    };
  }

  /**
   * Reads a message's fate from 2Factor's transactional report API.
   *
   * This exists because 2Factor posts DLR webhooks only for sends made through
   * the OTP endpoint (`mode=SMS_OTP`); messages sent through the transactional
   * endpoint never produce one. Measured on production: of 100 transactional
   * sends, 0 received a webhook, against 3,956 of 3,973 for the OTP endpoint.
   * Without this poll those messages sit at `sent` forever and are never
   * billed, even the ones that did reach the handset.
   *
   * OTP-endpoint session ids (`msj…`) are not in this report's index — it
   * answers `logStatus: Invalid` for them — which surfaces as `unknown` and
   * leaves the webhook to do its job.
   */
  async getDeliveryStatus(providerMsgId: string): Promise<DlrResult> {
    if (!providerMsgId) return { status: 'unknown' };

    const url = `${this.baseUrl}/${this.apiKey}/ADDON_SERVICES/RPT/TSMS/${providerMsgId}`;
    try {
      const response = await axios.get(url, {
        responseType: 'text',
        transformResponse: [(body: unknown) => body],
        timeout: REPORT_TIMEOUT_MS,
      });
      return this.parseTsmsReport(String(response.data));
    } catch (error: any) {
      // A report we could not fetch is not a delivery failure. Returning
      // `unknown` leaves the message in flight to be retried, rather than
      // marking it failed on a network blip.
      this.logger.warn(
        `2Factor report lookup failed for ${providerMsgId}: ${error?.message}`,
      );
      return { status: 'unknown' };
    }
  }

  /**
   * The report is a single flat record with no attributes, namespaces or
   * repeated tags, so it is read with a tag matcher rather than by taking on
   * an XML parser. `fast-xml-parser` is present in the tree but only as a
   * transitive dependency of the AWS SDK — depending on it directly would
   * break the moment that transitive pin moves.
   */
  private parseTsmsReport(xml: string): DlrResult {
    const tag = (name: string): string | null => {
      const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      return m ? m[1].trim() : null;
    };

    if ((tag('logStatus') ?? '').toLowerCase() !== 'valid') {
      return {
        status: 'unknown',
        description: 'No transactional report for this session id',
      };
    }

    const statusDesc = tag('statusDesc') ?? '';
    const errorCode = normalizeErrorCode(tag('errorId'));

    // The error code is the more specific signal, but 2Factor sends `000` on
    // some non-delivered rows, so it only decides the outcome when it does not
    // contradict an explicit terminal status name.
    const byName = mapTwoFactorStatusName(statusDesc);
    const byCode = TWO_FACTOR_ERROR_MAP[errorCode];

    let status: DlrResult['status'] = byName;
    let description = statusDesc || undefined;

    if (byCode && !(byCode.outcome === 'delivered' && byName === 'failed')) {
      status = byCode.outcome;
      description = statusDesc || byCode.reason;
    }

    const deliveredAt = parseIstTimestamp(tag('deliveredAt'));
    const credits = Number(tag('creditsCharged'));
    const body = tag('messageBody');

    return {
      status,
      description,
      // A rejected or barred row still carries a deliveredAt. Recording it
      // would make a failed message read as delivered in the history.
      deliveredAt:
        status === 'delivered' ? (deliveredAt ?? undefined) : undefined,
      // Curated text only. `statusDesc` is 2Factor's vocabulary (REJECTD,
      // FAILED(BARRED)) and naming it to a customer discloses the provider.
      failureReason:
        status === 'failed' ? customerFacingReason(errorCode) : undefined,
      providerFailureReason:
        status === 'failed' ? statusDesc || undefined : undefined,
      senderId: tag('smsFrom') ?? undefined,
      characterCount: body ? body.length : undefined,
      smsCount: Number.isFinite(credits) && credits > 0 ? credits : undefined,
      rawResponse: {
        statusDesc,
        errorId: tag('errorId'),
        sentAt: tag('sentAt'),
        deliveredAt: tag('deliveredAt'),
        smsTo: tag('smsTo'),
        creditsCharged: tag('creditsCharged'),
      },
    };
  }

  private extractOtp(content: string): string | null {
    // Look for 4-6 digit numeric code
    const match = content.match(/\d{4,6}/);
    return match ? match[0] : null;
  }
}
