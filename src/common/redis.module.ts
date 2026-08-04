import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url');
        if (!url) return null;
        const prefix = config.get<string>('redis.keyPrefix');
        // ioredis applies `keyPrefix` to the key arguments of ordinary
        // commands, which is all this client is used for — OTP throttling
        // counters and referral click de-duplication.
        return new Redis(url, prefix ? { keyPrefix: `${prefix}:` } : {});
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
