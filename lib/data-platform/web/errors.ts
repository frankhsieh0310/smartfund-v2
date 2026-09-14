import type { ServiceErrorShape, ServiceResponse } from "./types.ts";
import { buildProvenance } from "./provenance.ts";

export class WebDataError extends Error {
  readonly code: ServiceErrorShape["code"];

  constructor(code: ServiceErrorShape["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "WebDataError";
  }
}

export const errorStatus = (code: ServiceErrorShape["code"]): number => {
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_QUERY" || code === "INVALID_PAGINATION") return 400;
  if (code === "DATA_UNAVAILABLE" || code === "SOURCE_PENDING") return 503;
  return 500;
};

export function errorResponse(error: unknown): { body: ServiceResponse<never>; status: number } {
  const known = error instanceof WebDataError;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known ? error.message : "Canonical data is temporarily unavailable.";
  return {
    status: errorStatus(code),
    body: {
      data: null,
      meta: {
        asOfDate: null,
        lastUpdated: null,
        freshnessStatus: "UNKNOWN",
        source: null,
        provenance: buildProvenance({}),
        coverageStatus: "UNKNOWN",
      },
      pagination: null,
      error: { code, message },
    },
  };
}
