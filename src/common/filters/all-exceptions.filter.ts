import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { getRequestId } from '../context/request-context.js';
import { ErrorCodes } from '../constants/error-codes.constant.js';
import { ApiErrorResponse } from '../interfaces/api-response.interface.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCodes.INTERNAL_ERROR;
    let message = 'Internal server error';
    let details: { field?: string; message: string }[] | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, any>;
        message = resp.message ?? exception.message;
        code = resp.code ?? this.httpStatusToErrorCode(statusCode);

        if (Array.isArray(resp.message)) {
          details = resp.message.map((m: string) => ({ message: m }));
          message = 'Validation failed';
          code = ErrorCodes.VALIDATION_ERROR;
        }
      }
    } else {
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : exception,
      );
    }

    const errorResponse: ApiErrorResponse = {
      success: false,
      statusCode,
      requestId: getRequestId() ?? 'unknown',
      timestamp: new Date().toISOString(),
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    };

    response.status(statusCode).json(errorResponse);
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
