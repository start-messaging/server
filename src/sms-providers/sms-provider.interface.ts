export interface SendSmsParams {
  to: string;
  content: string;
  templateIdentifiers?: Record<string, string>;
  /**
   * True when the message's template has more than one variable. 2Factor's
   * OTP endpoint (/SMS/{phone}/{otp}/{template}) fills only the OTP, so a
   * multi-variable template sent that way leaves its other {#var#} slots empty
   * and 2Factor falls back to a voice call. These go through the transactional
   * endpoint with the fully rendered text instead.
   */
  multiVariable?: boolean;
}

export interface SendSmsResult {
  providerMsgId: string;
  status: 'queued' | 'sent' | 'failed';
  failureReason?: string;
  errorType?: 'validation' | 'service';
}

export interface DlrResult {
  status: 'sent' | 'delivered' | 'failed' | 'unknown';
  description?: string;
  senderId?: string;
  smsLanguage?: string;
  characterCount?: number;
  smsCount?: number;
  providerCost?: number;
  deliveredAt?: Date;
  rawResponse?: any;
}

export interface SmsProvider {
  name: string;
  priority: number;
  sendSms(params: SendSmsParams): Promise<SendSmsResult>;
  getDeliveryStatus(providerMsgId: string): Promise<DlrResult>;
  isHealthy(): Promise<boolean>;
}
