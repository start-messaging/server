export interface PaginationMeta {
  page: number;
  limit: number;
  /** -1 when the client passed `withCount=false` and the total is unknown. */
  totalItems: number;
  /** -1 when the client passed `withCount=false` and the total is unknown. */
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Pagination metadata for keyset-paginated (cursor) endpoints. */
export interface CursorPaginationMeta {
  limit: number;
  /** Opaque token to pass back as `?cursor=` for the next page. */
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface ApiSuccessResponse<T> {
  success: true;
  statusCode: number;
  requestId: string;
  timestamp: string;
  data: T;
  pagination?: PaginationMeta;
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  requestId: string;
  timestamp: string;
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
