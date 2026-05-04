import Joi from 'joi';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),

  // Database
  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_NAME: Joi.string().required(),
  DATABASE_USERNAME: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),

  // Auth
  BCRYPT_ROUNDS: Joi.number().min(4).max(20).default(10),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),

  // CORS
  CORS_ORIGINS: Joi.string().optional(),

  // Fast2SMS
  FAST2SMS_API_KEY: Joi.string().optional(),
  FAST2SMS_ROUTE: Joi.string().valid('otp', 'q', 'dlt').default('dlt'),
  FAST2SMS_SENDER_ID: Joi.string().optional(),
  FAST2SMS_DLT_TEMPLATE_ID: Joi.string().optional(),

  // Razorpay (optional)
  RAZORPAY_KEY_ID: Joi.string().optional(),
  RAZORPAY_KEY_SECRET: Joi.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: Joi.string().optional(),

  // Cloudflare R2
  R2_ACCOUNT_ID: Joi.string().optional(),
  R2_ACCESS_KEY_ID: Joi.string().optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().optional(),
  R2_BUCKET_NAME: Joi.string().optional(),
  R2_PUBLIC_URL: Joi.string().optional(),

  // OTP
  OTP_EXPIRY_MINUTES: Joi.number().default(5),
  OTP_COST: Joi.number().default(0.25),

  // Redis
  REDIS_URL: Joi.string().optional(),

  // Mailgun
  MAILGUN_API_KEY: Joi.string().optional(),
  MAILGUN_DOMAIN: Joi.string().optional(),
  MAILGUN_FROM_NAME: Joi.string().default('StartMessaging'),
  MAILGUN_FROM_EMAIL: Joi.string().optional(),
  MAILGUN_REPLY_TO_EMAIL: Joi.string().email().optional(),
  
  // Custom testing
  MOCK_SMS_SEND: Joi.boolean().default(false),
});
