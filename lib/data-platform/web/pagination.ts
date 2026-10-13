import { WebDataError } from "./errors.ts";
import type { PaginationMeta } from "./types.ts";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function normalizePagination(page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new WebDataError("INVALID_PAGINATION", `page must be >= 1 and pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function paginationMeta(page: number, pageSize: number, total: number, nextCursor: string | null = null): PaginationMeta {
  return { page, pageSize, total, hasNextPage: page * pageSize < total, nextCursor };
}
