import { Module } from '@nestjs/common';
import { LoggerModule, Params } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'http';
import { Writable } from 'stream';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import * as crypto from 'crypto';

interface RequestWithSession {
  id?: string;
  user?: { id: string; role: string };
  apiKeyId?: string;
}

interface PinoLogEntry {
  level: number;
  time: number;
  pid: number;
  hostname: string;
  msg?: string;
  v?: number;
  [key: string]: unknown;
}

const PINO_TO_OTEL: Record<number, { number: SeverityNumber; text: string }> = {
  10: { number: SeverityNumber.TRACE, text: 'TRACE' },
  20: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  30: { number: SeverityNumber.INFO, text: 'INFO' },
  40: { number: SeverityNumber.WARN, text: 'WARN' },
  50: { number: SeverityNumber.ERROR, text: 'ERROR' },
  60: { number: SeverityNumber.FATAL, text: 'FATAL' },
};

/**
 * Writable stream that forwards pino JSON log lines to the global
 * OpenTelemetry LoggerProvider (registered by src/telemetry.ts).
 *
 * Runs in the main thread — no worker-thread isolation issues.
 */
function createOtelStream(): Writable {
  const otelLogger = logs.getLogger('start-messaging-server');

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const log = JSON.parse(chunk.toString()) as PinoLogEntry;
        const severity = PINO_TO_OTEL[log.level] ?? {
          number: SeverityNumber.UNSPECIFIED,
          text: 'UNSPECIFIED',
        };

        // Separate pino internals from business attributes
        const {
          level: _level,
          time: _time,
          pid: _pid,
          hostname: _hostname,
          msg,
          v: _v,
          ...rest
        } = log;

        // Flatten one level deep so PostHog can index the fields
        const attributes: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(rest)) {
          if (value == null) continue;
          if (typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(
              value as Record<string, unknown>,
            )) {
              if (v != null && typeof v !== 'object') {
                attributes[`${key}.${k}`] = v as string | number | boolean;
              }
            }
          } else if (typeof value !== 'object') {
            attributes[key] = value as string | number | boolean;
          }
        }

        otelLogger.emit({
          severityNumber: severity.number,
          severityText: severity.text,
          body: msg ?? '',
          attributes,
        });
      } catch {
        // Never let OTEL errors break application logging
      }
      callback();
    },
  });
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): Params => {
        const isProduction = config.get('NODE_ENV') === 'production';
        const posthogApiKey = config.get<string>('POSTHOG_API_KEY');

        const pinoHttpOptions: pino.LoggerOptions & Record<string, unknown> = {
          level: isProduction ? 'info' : 'debug',
          genReqId: (req: IncomingMessage) =>
            (req as any).id ?? globalThis.crypto.randomUUID(),
          serializers: {
            req(raw) {
              const req = raw as IncomingMessage & { id?: string };
              const forwarded = req.headers['x-forwarded-for'];
              return {
                id: req.id,
                method: req.method,
                url: req.url,
                remoteAddress: forwarded
                  ? String(forwarded).split(',')[0].trim()
                  : req.socket?.remoteAddress,
                userAgent: req.headers['user-agent'],
              };
            },
          },
          redact: {
            paths: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          customProps: (req: IncomingMessage) => {
            const r = req as any;
            return {
              userId: r.user?.id,
              userRole: r.user?.role,
              apiKeyId: r.apiKeyId,
            };
          },
          customLogLevel: (
            _req: IncomingMessage,
            res: { statusCode: number },
            err?: Error,
          ) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },
          autoLogging: false,
        };

        // Standard logs (this.logger.log) now only go to the console.
        // We do NOT use createOtelStream here anymore.
        // PostHog Logs will now ONLY receive our specialized Interceptor and Filter logs.
        if (posthogApiKey) {
          const consoleStream = isProduction
            ? process.stdout
            : pinoPretty({
                colorize: true,
                singleLine: false,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
              });
          return {
            pinoHttp: [pinoHttpOptions, consoleStream],
          };
        }

        // Production without PostHog: plain stdout JSON
        if (isProduction) {
          return {
            pinoHttp: [pinoHttpOptions, process.stdout],
          };
        }

        // Development without PostHog: pino-pretty via worker-thread transport
        return {
          pinoHttp: {
            ...pinoHttpOptions,
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: false,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
              },
            },
          },
        };
      },
    }),
  ],
})
export class AppLoggerModule {}
