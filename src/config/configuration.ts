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
  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN,
    fromName: process.env.MAILGUN_FROM_NAME ?? 'StartMessaging',
    fromEmail: process.env.MAILGUN_FROM_EMAIL,
  },
  payments: {
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
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
