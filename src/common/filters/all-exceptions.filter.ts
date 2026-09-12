import {
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  ExceptionFilter,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { randomUUID } from 'crypto';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import * as Sentry from '@sentry/nestjs';
import { ErrorCodes } from '../constants/error-codes.constant.js';
import { ApiErrorResponse } from '../interfaces/api-response.interface.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const otelLogger = logs.getLogger('start-messaging-server');
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    let message = this.extractMessage(exceptionResponse);
    const errorId = (request as any).id || randomUUID();

    const logBody = `[${status}] Outgoing Error: ${request.method} ${request.url} - ${message}`;
    const attributes = {
      'request.id': String(errorId),
      'http.method': request.method,
      'http.url': request.url,
      'http.status_code': status,
      'error.message': message,
      ...(exception instanceof Error ? { 'error.stack': exception.stack } : {}),
    };

    // Log the error for PostHog (via OTEL)
    otelLogger.emit({
      severityNumber:
        status >= 500 ? SeverityNumber.ERROR : SeverityNumber.WARN,
      severityText: status >= 500 ? 'ERROR' : 'WARN',
      body: logBody,
      attributes,
    });

    // Log the error for Console (via Pino)
    if (status >= 500) {
      this.logger.error(
        logBody,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(logBody);
    }

    // Report when the throw was NOT a deliberate HttpException, OR when it
    // resolved to 5xx. The `instanceof` test on its own silently dropped every
    // deliberate server error: InternalServerErrorException,
    // ServiceUnavailableException and BadGatewayException are all
    // HttpExceptions, so a genuine 500 raised on purpose never reached Sentry.
    // Expected 4xx stays out — that is the client being told no, not a fault to
    // investigate — which is why the second test is `>= 500` and not `!== 200`.
    //
    // request.id is tagged so a Sentry issue can be matched to the OTEL log line
    // emitted just above; they are the same incident and otherwise share no key.
    if (!(exception instanceof HttpException) || status >= 500) {
      Sentry.captureException(exception, {
        tags: { request_id: String(errorId) },
        extra: attributes,
      });
    }

    let code: string = ErrorCodes.INTERNAL_ERROR;
    let details: any;

    if (exception instanceof HttpException) {
      const resp = exception.getResponse() as any;
      code = resp.code || this.httpStatusToErrorCode(status);
      if (Array.isArray(resp.message)) {
        details = resp.message.map((m: string) => ({ message: m }));
        message = resp.message[0] || 'Validation failed';
        code = ErrorCodes.VALIDATION_ERROR;
      }
    }

    const errorResponse: ApiErrorResponse = {
      success: false,
      statusCode: status,
      requestId: errorId,
      timestamp: new Date().toISOString(),
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    };

    response.status(status).json(errorResponse);
  }

  private extractMessage(input: unknown): string {
    if (input === null || input === undefined) return 'Internal server error';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') {
      const obj = input as any;
      if (Array.isArray(obj.message)) return obj.message[0];
      return obj.message || obj.error || JSON.stringify(obj);
    }
    return String(input);
  }

  private httpStatusToErrorCode(status: number): string {
    switch (status) {
      case 400:
        return ErrorCodes.INVALID_INPUT;
      case 401:
        return ErrorCodes.UNAUTHORIZED;
      case 403:
        return ErrorCodes.FORBIDDEN;
      case 404:
        return ErrorCodes.NOT_FOUND;
      case 409:
        return ErrorCodes.CONFLICT;
      default:
        return ErrorCodes.INTERNAL_ERROR;
    }
  }
}
