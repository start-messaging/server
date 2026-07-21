export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    name: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  auth: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiration: process.env.JWT_EXPIRATION ?? '15m',
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION ?? '7d',
  },
  sms: {
    // 'console' (dev/test, logs the OTP) or 'twofactor' (real gateway).
    driver: process.env.SMS_DRIVER ?? 'console',
    fast2sms: {
      apiKey: process.env.FAST2SMS_API_KEY,
      route: process.env.FAST2SMS_ROUTE ?? 'dlt',
      senderId: process.env.FAST2SMS_SENDER_ID,
      dltTemplateId: process.env.FAST2SMS_DLT_TEMPLATE_ID,
    },
    twoFactor: {
      apiKey: process.env.TWOFACTOR_API_KEY,
      templateName: process.env.TWOFACTOR_TEMPLATE_NAME || 'OTP',
    },
  },
  mail: {
    // 'console' (dev/test, logs the email) or 'mailgun' (real transport).
    driver: process.env.MAIL_DRIVER ?? 'console',
  },
  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN,
    fromName: process.env.MAILGUN_FROM_NAME ?? 'StartMessaging',
    fromEmail: process.env.MAILGUN_FROM_EMAIL,
    replyToEmail: process.env.MAILGUN_REPLY_TO_EMAIL,
  },
  payments: {
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    },
    // Customer-fee-bearer model: the user pays Razorpay's platform fee + GST on
    // top of their top-up; only the base amount is credited to the wallet.
    fee: {
      // Platform fee percentage of the base top-up (Razorpay standard MDR ~2%).
      percent: parseFloat(process.env.RAZORPAY_FEE_PERCENT ?? '2'),
      // GST percentage charged on the platform fee (18% in India).
      gstPercent: parseFloat(process.env.RAZORPAY_GST_PERCENT ?? '18'),
      // 'customer' = user bears the fee (default); 'platform' = we absorb it.
      bearer: process.env.PAYMENT_FEE_BEARER ?? 'customer',
    },
  },
  affiliate: {
    // Percentage of a referred user's base top-up paid to the partner.
    commissionPercent: parseFloat(
      process.env.AFFILIATE_COMMISSION_PERCENT ?? '10',
    ),
    // A partner needs at least this many PAID referred users to withdraw.
    minPaidUsers: parseInt(process.env.AFFILIATE_MIN_PAID_USERS ?? '10', 10),
    // Minimum withdrawable earnings balance, in the major unit (rupees).
    minWithdrawal: parseFloat(process.env.AFFILIATE_MIN_WITHDRAWAL ?? '1000'),
    // Payouts may only be requested/processed within this day-of-month window.
    payoutWindow: {
      startDay: parseInt(process.env.AFFILIATE_PAYOUT_START_DAY ?? '21', 10),
      endDay: parseInt(process.env.AFFILIATE_PAYOUT_END_DAY ?? '28', 10),
    },
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicUrl: process.env.R2_PUBLIC_URL,
  },
  cors: {
    origins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
      : [
          'https://app.startmessaging.com',
          'https://admin.startmessaging.com',
          'http://localhost:5173',
          'http://localhost:5174',
          'http://localhost:5175',
        ],
  },
  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES ?? '5', 10),
    costPerOtp: parseFloat(process.env.OTP_COST ?? '0.25'),
  },
  currencies: {
    supported: ['INR'],
    default: 'INR',
    config: {
      INR: {
        gateway: 'razorpay',
        minTopUp: 1000,
        otpCost: parseFloat(process.env.OTP_COST ?? '0.25'),
        locale: 'en-IN',
      },
    },
  },
});
