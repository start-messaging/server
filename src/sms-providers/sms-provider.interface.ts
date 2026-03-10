export interface SendSmsParams {
  to: string;
  content: string;
}

export interface SendSmsResult {
  providerMsgId: string;
  status: 'queued' | 'sent' | 'failed';
  failureReason?: string;
  errorType?: 'validation' | 'service';
}

export interface SmsProvider {
  name: string;
  priority: number;
  sendSms(params: SendSmsParams): Promise<SendSmsResult>;
  getDeliveryStatus(providerMsgId: string): Promise<string>;
  isHealthy(): Promise<boolean>;
}
