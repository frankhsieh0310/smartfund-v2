import { readFile } from "node:fs/promises";

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

const secretKey = /^(cookie|authorization|proxy-authorization|x-api-key|x-xsrf-token|crumb|token|access[_-]?token|session|set-cookie)$/i;
const secretValue = /(?:cookie|authorization|x-api-key|x-xsrf-token|crumb|token|session)=/i;
const tickerKeys = /^(symbol|ticker|tickers|quote)$/i;

function sanitizeValue(key: string, value: string): { value: string; sensitive: boolean } {
  return secretKey.test(key) || secretValue.test(`${key}=${value}`) ? { value: "[REDACTED]", sensitive: true } : { value, sensitive: false };
}

function shapeFromUrl(source: "CURL" | "HAR", method: string, rawUrl: string, headers: Header[], body = "", responseContentType: string | null = null, status: number | null = null): RequestShape {
  const url = new URL(rawUrl);
  let sensitive = headers.some((header) => secretKey.test(header.name) || secretValue.test(header.value));
  const query = [...url.searchParams.entries()].map(([key, rawValue]) => {
    const value = sanitizeValue(key, rawValue);
    sensitive ||= value.sensitive;
    return { key, value: value.value };
  });
  const pathTicker = url.pathname.match(/\/quote\/([^/?]+)/i)?.[1] ?? null;
  const queryTicker = query.find((item) => tickerKeys.test(item.key))?.value ?? null;
  const bodyTicker = body.match(/(?:symbol|ticker)=([A-Za-z0-9.^=-]+)/i)?.[1] ?? null;
  const ticker = pathTicker ? { value: pathTicker, location: "path" as const } : queryTicker ? { value: queryTicker, location: "query" as const } : bodyTicker ? { value: bodyTicker, location: "body" as const } : { value: null, location: "unknown" as const };
  const pathAndQuery = `${url.pathname}?${url.search}`.toLowerCase();
  const isCsv = /csv/.test(responseContentType ?? "") || /(?:csv|download|export)/.test(pathAndQuery);
  const isJson = /json/.test(responseContentType ?? "") || /json/.test(pathAndQuery);
  const responseKind = isCsv ? "DIRECT_CSV" : status && status >= 300 && status < 400 ? "SIGNED_URL_OR_REDIRECT" : isJson ? "JSON" : "UNKNOWN";
  return { source, method, host: url.host, pathname: url.pathname, query, ticker, dataType: body ? "REQUEST_BODY_PRESENT" : null, responseContentType, responseKind, redirectStatus: status && status >= 300 && status < 400 ? status : null, sensitiveInputDetected: sensitive };
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

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: analyze-request.ts <masked-curl-or-har-file>");
  const input = await readFile(file, "utf8");
  const shapes = input.trimStart().startsWith("{") ? analyzeHar(input) : analyzeCurl(input);
  const relevant = shapes.filter((shape) => /csv|download|export|valuation|fundamental|financial/i.test(`${shape.pathname}?${shape.query.map((item) => `${item.key}=${item.value}`).join("&")}`));
  console.log(JSON.stringify({ requestCount: shapes.length, relevantCount: relevant.length, requests: relevant, note: "Sensitive headers and query values are never printed." }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
