import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

type Header = { name: string; value: string };
type RequestShape = {
  source: "CURL" | "HAR";
  method: string;
  host: string | null;
  pathname: string | null;
  query: Array<{ key: string; value: string }>;
  ticker: { value: string | null; location: "path" | "query" | "body" | "unknown" };
  dataType: string | null;
  responseContentType: string | null;
  responseKind: "DIRECT_CSV" | "JSON" | "SIGNED_URL_OR_REDIRECT" | "UNKNOWN";
  redirectStatus: number | null;
  sensitiveInputDetected: boolean;
};
type InterceptorLog = { kind?: string; timestamp?: string; label?: string; method?: string | null; requestUrl?: string | null; status?: number | null; contentType?: string | null; blobMimeType?: string | null; blobSize?: number | null; bodyPreview?: string; containsValuationKeywords?: boolean };

const secretKey = /^(cookie|authorization|proxy-authorization|x-api-key|x-xsrf-token|crumb|token|access[_-]?token|session|set-cookie)$/i;
const secretValue = /(?:cookie|authorization|x-api-key|x-xsrf-token|crumb|token|session)=/i;
const tickerKeys = /^(symbol|ticker|tickers|quote)$/i;

function sanitizeValue(key: string, value: string): { value: string; sensitive: boolean } {
  return secretKey.test(key) || secretValue.test(`${key}=${value}`) ? { value: "[REDACTED]", sensitive: true } : { value, sensitive: false };
}

function describeUrl(rawUrl: string | null | undefined) {
  if (!rawUrl) return { host: null, pathname: null, query: [] as Array<{ key: string; value: string }>, ticker: { value: null, location: "unknown" as const }, signed: false, frequency: [] as Array<{ key: string; value: string }> };
  try {
    const url = new URL(rawUrl);
    const query = [...url.searchParams.entries()].map(([key, rawValue]) => ({ key, value: sanitizeValue(key, rawValue).value }));
    const pathTicker = url.pathname.match(/\/quote\/([^/?]+)/i)?.[1] ?? null;
    const queryTicker = query.find((item) => tickerKeys.test(item.key))?.value ?? null;
    const frequency = query.filter((item) => /^(period|frequency|interval|timescale|type|module)$/i.test(item.key));
    return { host: url.host, pathname: url.pathname, query, ticker: pathTicker ? { value: pathTicker, location: "path" as const } : queryTicker ? { value: queryTicker, location: "query" as const } : { value: null, location: "unknown" as const }, signed: query.some((item) => /(signature|expires|signed|x-amz|x-goog)/i.test(item.key)), frequency };
  } catch {
    return { host: null, pathname: null, query: [], ticker: { value: null, location: "unknown" as const }, signed: false, frequency: [] };
  }
}

function shapeFromUrl(source: "CURL" | "HAR", method: string, rawUrl: string, headers: Header[], body = "", responseContentType: string | null = null, status: number | null = null): RequestShape {
  const described = describeUrl(rawUrl);
  const bodyTicker = body.match(/(?:symbol|ticker)=([A-Za-z0-9.^=-]+)/i)?.[1] ?? null;
  const pathAndQuery = `${described.pathname}?${described.query.map((item) => `${item.key}=${item.value}`).join("&")}`.toLowerCase();
  const isCsv = /csv/.test(responseContentType ?? "") || /(?:csv|download|export)/.test(pathAndQuery);
  const isJson = /json/.test(responseContentType ?? "") || /json/.test(pathAndQuery);
  return {
    source, method, host: described.host, pathname: described.pathname, query: described.query,
    ticker: described.ticker.value ? described.ticker : bodyTicker ? { value: bodyTicker, location: "body" } : described.ticker,
    dataType: body ? "REQUEST_BODY_PRESENT" : null,
    responseContentType,
    responseKind: isCsv ? "DIRECT_CSV" : status && status >= 300 && status < 400 ? "SIGNED_URL_OR_REDIRECT" : isJson ? "JSON" : "UNKNOWN",
    redirectStatus: status && status >= 300 && status < 400 ? status : null,
    sensitiveInputDetected: headers.some((header) => secretKey.test(header.name) || secretValue.test(header.value)) || described.query.some((item) => item.value === "[REDACTED]"),
  };
}

function analyzeCurl(input: string): RequestShape[] {
  const url = input.match(/https?:\/\/[^\s'"\\]+/)?.[0];
  if (!url) throw new Error("CURL_URL_NOT_FOUND");
  const method = input.match(/(?:-X|--request)\s+['"]?([A-Z]+)['"]?/i)?.[1]?.toUpperCase() ?? "GET";
  const headers = [...input.matchAll(/(?:-H|--header)\s+['"]([^'"\r\n]+)['"]/g)].map((match) => {
    const [name, ...rest] = match[1].split(":");
    return { name: name.trim(), value: rest.join(":").trim() };
  });
  const body = input.match(/(?:--data(?:-raw)?|-d)\s+['"]([^'"\r\n]+)['"]/i)?.[1] ?? "";
  return [shapeFromUrl("CURL", method, url, headers, body)];
}

function analyzeHar(input: string): RequestShape[] {
  const har = JSON.parse(input) as { log?: { entries?: Array<{ request?: { method?: string; url?: string; headers?: Header[]; postData?: { text?: string } }; response?: { status?: number; headers?: Header[]; content?: { mimeType?: string } } }> } };
  const entries = har.log?.entries ?? [];
  if (!entries.length) throw new Error("HAR_ENTRIES_NOT_FOUND");
  return entries.flatMap((entry) => {
    const request = entry.request;
    if (!request?.url) return [];
    const contentType = entry.response?.content?.mimeType ?? entry.response?.headers?.find((header) => /^content-type$/i.test(header.name))?.value ?? null;
    return [shapeFromUrl("HAR", request.method ?? "GET", request.url, request.headers ?? [], request.postData?.text ?? "", contentType, entry.response?.status ?? null)];
  });
}

export function analyzeInterceptorCapture(value: unknown) {
  const logs = Array.isArray(value) ? value as InterceptorLog[] : (value && typeof value === "object" && Array.isArray((value as { logs?: unknown }).logs) ? (value as { logs: InterceptorLog[] }).logs : null);
  if (!logs) throw new Error("INTERCEPTOR_LOGS_NOT_FOUND");
  const marks = logs.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "MARK");
  const requests = logs.map((entry, index) => ({ index, ...entry, ...describeUrl(entry.requestUrl) })).filter((entry) => entry.kind !== "MARK");
  const valuationHits = requests.filter((entry) => entry.containsValuationKeywords);
  const downloadsAfterMark = marks.map(({ entry, index }) => ({ label: entry.label ?? "marker", newRequests: requests.filter((request) => request.index > index).length }));
  const frequencies = [...new Set(requests.flatMap((entry) => entry.frequency.map((item) => `${item.key}=${item.value}`)))];
  const statusCodes = [...new Set(requests.map((entry) => entry.status).filter((status): status is number => typeof status === "number"))];
  return {
    captureType: "YAHOO_NETWORK_INTERCEPTOR",
    requestCount: requests.length,
    valuationHitUrls: valuationHits.map((entry) => ({ kind: entry.kind, method: entry.method ?? null, url: entry.requestUrl ?? null, status: entry.status ?? null, contentType: entry.contentType ?? null, ticker: entry.ticker, frequency: entry.frequency })),
    tickerLocations: [...new Set(requests.map((entry) => `${entry.ticker.location}:${entry.ticker.value ?? "UNKNOWN"}`))],
    annualQuarterlyMonthlyParameters: frequencies,
    downloadNewRequestsAfterMarks: downloadsAfterMark,
    blobDownloads: requests.filter((entry) => entry.kind === "BLOB").map((entry) => ({ mimeType: entry.blobMimeType ?? entry.contentType ?? null, size: entry.blobSize ?? null, bodyPreview: entry.bodyPreview ?? "" })),
    replaceableTickerEvidence: requests.filter((entry) => entry.ticker.location !== "unknown").map((entry) => ({ ticker: entry.ticker, url: entry.requestUrl ?? null })),
    signedUrlEvidence: requests.filter((entry) => entry.signed || (entry.status !== null && entry.status !== undefined && entry.status >= 300 && entry.status < 400)).map((entry) => ({ url: entry.requestUrl ?? null, status: entry.status ?? null })),
    goldAuthorizationEvidence: statusCodes.some((status) => status === 401 || status === 403) ? "AUTHORIZATION_ERROR_OBSERVED" : "NOT_OBSERVABLE_WITH_SANITIZED_LOGS",
    recommendation: valuationHits.length > 0 && requests.some((entry) => entry.ticker.location !== "unknown") ? "RUN_AAPL_MSFT_NVDA_MINIMUM_TEST" : "CAPTURE_DOES_NOT_YET_PROVE_A_REUSABLE_TICKER_REQUEST",
    note: "Request headers, Cookie, storage, and request bodies are intentionally not collected or analyzed.",
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: analyze-request.ts <sanitized-interceptor-json-curl-or-har-file>");
  const input = await readFile(file, "utf8");
  const trimmed = input.trimStart();
  const parsed = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(input) : null;
  if (Array.isArray(parsed) || (parsed && "logs" in parsed && !("log" in parsed))) {
    console.log(JSON.stringify(analyzeInterceptorCapture(parsed), null, 2));
    return;
  }
  const shapes = parsed ? analyzeHar(input) : analyzeCurl(input);
  const relevant = shapes.filter((shape) => /csv|download|export|valuation|fundamental|financial/i.test(`${shape.pathname}?${shape.query.map((item) => `${item.key}=${item.value}`).join("&")}`));
  console.log(JSON.stringify({ requestCount: shapes.length, relevantCount: relevant.length, requests: relevant, note: "Sensitive headers and query values are never printed." }, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
