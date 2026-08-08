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
  GENERIC_FAILURE_REASON,
  TWO_FACTOR_ERROR_MAP,
  customerFacingReason,
  mapTwoFactorStatusName,
  normalizeErrorCode,
  parseIstTimestamp,
} from './two-factor-status.js';

@Injectable()
export class TwoFactorProvider implements SmsProvider {
  private readonly logger = new Logger(TwoFactorProvider.name);
  private readonly apiKey: string;
  private readonly templateName: string;
  private readonly senderId: string;
  private readonly baseUrl = 'https://2factor.in/API/V1';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('sms.twoFactor.apiKey') ?? '';
    this.templateName =
      this.config.get<string>('sms.twoFactor.templateName') ?? 'OTP';
    this.senderId =
      this.config.get<string>('sms.twoFactor.senderId') ?? 'STMSG';
  }

  get name(): string {
    return '2factor';
  }

  get priority(): number {
    return 1; // Primary provider
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(!!this.apiKey);
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    // A template with more than one variable cannot be filled by the OTP
    // endpoint (it only substitutes the OTP), so 2Factor would leave the other
    // variables empty and fall back to a voice call. The transactional
    // endpoint takes the fully rendered message instead.
    if (params.multiVariable) {
      return this.sendTransactional(params);
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
      const response = await axios.get(url);

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
   * Sends a DLT-approved multi-variable template through 2Factor's
   * transactional endpoint. The fully rendered message is passed as `Msg`;
   * the operator's DLT scrubbing matches it against the approved template for
   * the sender header, so the variable boundaries in our stored body do not
   * have to line up with 2Factor's {#var#} slots — only the final text has to
   * match the approved content.
   *
   * Endpoint: POST /API/V1/{api_key}/ADDON_SERVICES/SEND/TSMS
   * Form fields: From (DLT header), To, Msg.
   */
  private async sendTransactional(
    params: SendSmsParams,
  ): Promise<SendSmsResult> {
    const url = `${this.baseUrl}/${this.apiKey}/ADDON_SERVICES/SEND/TSMS`;
    const form = new URLSearchParams({
      From: this.senderId,
      To: params.to,
      Msg: params.content,
    });

    try {
      this.logger.debug(
        `Sending 2Factor transactional SMS to ${params.to} (from ${this.senderId})`,
      );
      const response = await axios.post(url, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      if (response.data.Status === 'Success') {
        return {
          providerMsgId: String(response.data.Details), // message/session id
          status: 'sent',
        };
      }

      // As in sendSms: a refusal arrives as HTTP 200 + Status:Error, so the
      // catch block never sees it and nothing recorded why.
      this.logger.error(
        `2Factor.in rejected transactional send to ${params.to} ` +
          `(from ${this.senderId}): ${JSON.stringify(response.data)}`,
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
      this.logger.error(`2Factor.in transactional API Error: ${errorMessage}`);
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
