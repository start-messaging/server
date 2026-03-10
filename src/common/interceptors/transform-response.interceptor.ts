import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { getRequestId } from '../context/request-context.js';
import {
  ApiSuccessResponse,
  PaginationMeta,
} from '../interfaces/api-response.interface.js';

export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

function isPaginatedResult(value: unknown): value is PaginatedResult<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'pagination' in value &&
    Array.isArray((value as PaginatedResult<unknown>).data)
  );
}

@Injectable()
export class TransformResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccessResponse<T>> {
    const statusCode = context.switchToHttp().getResponse().statusCode;

    return next.handle().pipe(
      map((responseData) => {
        const base = {
          success: true as const,
          statusCode,
          requestId: getRequestId() ?? 'unknown',
          timestamp: new Date().toISOString(),
        };

        if (isPaginatedResult(responseData)) {
          return {
            ...base,
            data: responseData.data as T,
            pagination: responseData.pagination,
          };
        }

        return {
          ...base,
          data: responseData,
        };
      }),
    );
  }
}
