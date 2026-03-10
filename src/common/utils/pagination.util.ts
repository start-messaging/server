import { PaginationMeta } from '../interfaces/api-response.interface.js';

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    totalItems: total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function paginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
) {
  return {
    data: items,
    pagination: buildPaginationMeta(total, page, limit),
  };
}
