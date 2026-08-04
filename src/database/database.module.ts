import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        database: config.get<string>('database.name'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
        logging:
          process.env.NODE_ENV === 'production' ? false : ['error', 'warn'], // Reduced noise (no more "query: SELECT...")
        // SSL follows DATABASE_SSL when it is set, and otherwise the old
        // rule (on in production). This lets a prod-like deployment —
        // NODE_ENV=production for behaviour — still talk to a local Postgres
        // that has no TLS, by setting DATABASE_SSL=false. Production sets
        // nothing and is unchanged.
        ssl:
          (
            process.env.DATABASE_SSL !== undefined
              ? process.env.DATABASE_SSL === 'true'
              : process.env.NODE_ENV === 'production'
          )
            ? { rejectUnauthorized: false }
            : false,
      }),
    }),
  ],
})
export class DatabaseModule {}
