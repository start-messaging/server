export interface SendSmsParams {
  to: string;
  content: string;
  templateIdentifiers?: Record<string, string>;
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
