import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { maskSensitiveData } from '../utils/mask-data.util.js';

const otelLogger = logs.getLogger('start-messaging-server');

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const { method, url, body, query, params, user, apiKeyId } = req;
    const role = user?.role ?? 'unauthenticated';
    const userId = user?.id ?? 'anonymous';
    const startTime = Date.now();

    // 1. INCOMING REQUEST LOG (Console & PostHog)
    const logBody = `[${role}] Incoming Request: ${method} ${url}`;
    const attributes = {
      'request.id': String(req.id || ''),
      'http.method': method,
      'http.url': url,
      'http.user_agent': req.get('user-agent'),
      'http.client_ip': req.ip,
      'user.id': String(userId),
      'user.role': role,
      apiKeyId: String(apiKeyId || ''),
      'request.body': JSON.stringify(maskSensitiveData(body)),
      'request.query': JSON.stringify(query),
      'request.params': JSON.stringify(params),
    };

    // Emit to PostHog via OTEL
    otelLogger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: logBody,
      attributes,
    });

    // Log to Console via Pino
    this.logger.log({ msg: logBody, ...attributes });

    return next.handle().pipe(
      tap({
        next: (responseBody) => {
          const duration = Date.now() - startTime;
          const statusCode = res.statusCode;
          const responseSize = JSON.stringify(responseBody)?.length || 0;

          // 2. SUCCESSFUL RESPONSE LOG (Console & PostHog)
          const resBody = `[${role}] Response Successful: ${statusCode} ${method} ${url}`;
          const resAttributes = {
            'request.id': String(req.id || ''),
            'http.method': method,
            'http.url': url,
            'http.status_code': statusCode,
            'user.id': String(userId),
            'user.role': role,
            apiKeyId: String(apiKeyId || ''),
            'response.size_bytes': responseSize,
            duration_ms: duration,
          };

          // Emit to PostHog via OTEL
          otelLogger.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: 'INFO',
            body: resBody,
            attributes: resAttributes,
          });

          // Log to Console via Pino
          this.logger.log({ msg: resBody, ...resAttributes });
        },
      }),
    );
  }
}
