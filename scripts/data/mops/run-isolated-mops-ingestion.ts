import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

export type BackfillMode = "NONE" | "YEAR" | "YEAR_MONTH" | "YEAR_QUARTER" | "DATE_RANGE" | "PAGE";
type ParameterNames = Partial<Record<"year" | "month" | "quarter" | "startDate" | "endDate" | "page", string>>;
type BackfillContract = { backfillMode?: BackfillMode; earliestYear?: number; latestYear?: number; months?: number[]; quarters?: number[]; startDate?: string; endDate?: string; dateStepDays?: number; startPage?: number; maxPages?: number; parameterNames?: ParameterNames; yearEncoding?: "AD" | "ROC"; monthFormat?: "NUMBER" | "TWO_DIGIT" };
type Domain = BackfillContract & { id: string; domain: string; endpoint: string | null; status: "READY" | "SOURCE_DISCOVERY_REQUIRED"; responseType?: "json" | "html"; linkPattern?: string; method?: "GET" | "POST" | "POST_FORM"; staticParameters?: Record<string, string>; sourceLimitations?: string };
type Registry = { version: number; source: string; baseUrl: string; mopsUrl: string; concurrency: 1; maxAttempts: number; minimumRequestIntervalMs: number; domains: Domain[] };
export type BackfillScope = { index: number; mode: BackfillMode; year?: number; month?: number; quarter?: number; startDate?: string; endDate?: string; page?: number; params: Record<string, string> };
export type BackfillCursor = { lastCompletedIndex: number; year?: number; month?: number; quarter?: number; startDate?: string; endDate?: string; page?: number; updatedAt: string };
type QueueItem = Domain & { state: "PENDING" | "RUNNING" | "COMPLETE" | "RETRY_WAIT" | "BLOCKED_SOURCE"; attempts: number; checkpoint: string | null; backfillCursor?: BackfillCursor | null; nextEligibleAt: string | null; lastError: string | null; updatedAt: string };

const runtimeRoot = path.resolve("runtime/mops-staging");
const queuePath = path.join(runtimeRoot, "queue.json");
const checkpointPath = path.join(runtimeRoot, "checkpoint.json");
const registryPath = path.resolve("config/mops-missing-data-source-registry.json");
const bootstrapOnly = process.argv.includes("--bootstrap");
const apply = process.argv.includes("--apply");
const selected = process.argv.find((arg) => arg.startsWith("--domain="))?.slice(9).toUpperCase() ?? null;
const iteratorSelfTest = process.argv.includes("--iterator-self-test");
const backfillDryRun = process.argv.includes("--backfill-dry-run");
const historicalSmokeArgument = process.argv.find((argument) => argument === "--historical-smoke" || argument.startsWith("--historical-smoke="));
const historicalSmoke = Boolean(historicalSmokeArgument);
const historicalSmokeSelection = historicalSmokeArgument?.includes("=") ? historicalSmokeArgument.split("=", 2)[1] : null;
const historicalSmokeReparse = process.argv.includes("--historical-smoke-reparse");

const DAY_MS = 86_400_000;
const isoDate = (value: Date) => value.toISOString().slice(0, 10);
function requireInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): asserts value is number { if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`MOPS_BACKFILL_INVALID_${label}`); }
function dateValue(value: string | undefined, label: string) { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`MOPS_BACKFILL_INVALID_${label}`); const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isFinite(date.getTime()) || isoDate(date) !== value) throw new Error(`MOPS_BACKFILL_INVALID_${label}`); return date; }
function scopeParams(scope: Omit<BackfillScope, "params">, config: Pick<BackfillContract, "parameterNames" | "yearEncoding" | "monthFormat"> = {}) { const names = config.parameterNames ?? {}; const params: Record<string, string> = {}; if (scope.year !== undefined) params[names.year ?? "year"] = String(config.yearEncoding === "ROC" ? scope.year - 1911 : scope.year); if (scope.month !== undefined) params[names.month ?? "month"] = config.monthFormat === "TWO_DIGIT" ? String(scope.month).padStart(2, "0") : String(scope.month); if (scope.quarter !== undefined) params[names.quarter ?? "quarter"] = String(scope.quarter); if (scope.startDate) params[names.startDate ?? "startDate"] = scope.startDate; if (scope.endDate) params[names.endDate ?? "endDate"] = scope.endDate; if (scope.page !== undefined) params[names.page ?? "page"] = String(scope.page); return params; }

export function createBackfillScopes(config: BackfillContract, cursor?: BackfillCursor | null, currentYear = new Date().getUTCFullYear()): BackfillScope[] {
  const mode = config.backfillMode ?? "NONE"; const raw: Array<Omit<BackfillScope, "index" | "params">> = [];
  if (mode === "NONE") raw.push({ mode });
  if (mode === "YEAR" || mode === "YEAR_MONTH" || mode === "YEAR_QUARTER") {
    requireInteger(config.earliestYear, "EARLIEST_YEAR", 1900, 9999); const latestYear = config.latestYear ?? currentYear; requireInteger(latestYear, "LATEST_YEAR", config.earliestYear, 9999);
    const months = config.months ?? Array.from({ length: 12 }, (_value, index) => index + 1); const quarters = config.quarters ?? [1, 2, 3, 4];
    if (mode === "YEAR_MONTH") for (const month of months) requireInteger(month, "MONTH", 1, 12); if (mode === "YEAR_QUARTER") for (const quarter of quarters) requireInteger(quarter, "QUARTER", 1, 4);
    for (let year = config.earliestYear; year <= latestYear; year += 1) { if (mode === "YEAR") raw.push({ mode, year }); if (mode === "YEAR_MONTH") for (const month of months) raw.push({ mode, year, month }); if (mode === "YEAR_QUARTER") for (const quarter of quarters) raw.push({ mode, year, quarter }); }
  }
  if (mode === "DATE_RANGE") { const start = dateValue(config.startDate, "START_DATE"); const end = dateValue(config.endDate, "END_DATE"); requireInteger(config.dateStepDays, "DATE_STEP_DAYS", 1, 3660); if (start > end) throw new Error("MOPS_BACKFILL_DATE_RANGE_REVERSED"); for (let windowStart = start; windowStart <= end; windowStart = new Date(windowStart.getTime() + config.dateStepDays * DAY_MS)) { const windowEnd = new Date(Math.min(end.getTime(), windowStart.getTime() + (config.dateStepDays - 1) * DAY_MS)); raw.push({ mode, startDate: isoDate(windowStart), endDate: isoDate(windowEnd) }); } }
  if (mode === "PAGE") { const startPage = config.startPage ?? 1; requireInteger(startPage, "START_PAGE", 1); requireInteger(config.maxPages, "MAX_PAGES", 1, 1_000_000); for (let page = startPage; page < startPage + config.maxPages; page += 1) raw.push({ mode, page }); }
  return raw.map((scope, index) => ({ ...scope, index, params: scopeParams(scope as Omit<BackfillScope, "params">, config) })).slice((cursor?.lastCompletedIndex ?? -1) + 1);
}
export function backfillCursorFor(scope: BackfillScope): BackfillCursor { return { lastCompletedIndex: scope.index, year: scope.year, month: scope.month, quarter: scope.quarter, startDate: scope.startDate, endDate: scope.endDate, page: scope.page, updatedAt: new Date().toISOString() }; }
export function shouldStopPageIteration(input: { recordCount: number; explicitLastPage?: boolean; currentPage: number; maxPage: number }) { return input.recordCount === 0 || input.explicitLastPage === true || input.currentPage >= input.maxPage; }

function runIteratorSelfTest() {
  const year = createBackfillScopes({ backfillMode: "YEAR", earliestYear: 2015, latestYear: 2024 }); const yearMonth = createBackfillScopes({ backfillMode: "YEAR_MONTH", earliestYear: 2015, latestYear: 2024 }); const yearQuarter = createBackfillScopes({ backfillMode: "YEAR_QUARTER", earliestYear: 2015, latestYear: 2024 }); const dateRange = createBackfillScopes({ backfillMode: "DATE_RANGE", startDate: "2024-01-01", endDate: "2024-01-10", dateStepDays: 3 }); const page = createBackfillScopes({ backfillMode: "PAGE", startPage: 2, maxPages: 5 });
  assert.equal(year.length, 10); assert.equal(yearMonth.length, 120); assert.equal(yearQuarter.length, 40); assert.equal(dateRange.length, 4); assert.deepEqual([dateRange.at(-1)?.startDate, dateRange.at(-1)?.endDate], ["2024-01-10", "2024-01-10"]); assert.deepEqual(page.map((scope) => scope.page), [2, 3, 4, 5, 6]); assert.equal(shouldStopPageIteration({ recordCount: 0, currentPage: 2, maxPage: 6 }), true); assert.equal(shouldStopPageIteration({ recordCount: 1, explicitLastPage: true, currentPage: 2, maxPage: 6 }), true); assert.throws(() => createBackfillScopes({ backfillMode: "YEAR_MONTH" }), /EARLIEST_YEAR/);
  const resume = createBackfillScopes({ backfillMode: "YEAR_MONTH", earliestYear: 2024, latestYear: 2024 }, backfillCursorFor(createBackfillScopes({ backfillMode: "YEAR_MONTH", earliestYear: 2024, latestYear: 2024 })[5])); assert.deepEqual(resume.map((scope) => scope.index), [6, 7, 8, 9, 10, 11]);
  console.log(JSON.stringify({ YEAR: year.length, YEAR_MONTH: yearMonth.length, YEAR_QUARTER: yearQuarter.length, DATE_RANGE: dateRange.length, PAGE: page.length, FAIL_CLOSED: "PASS", RESUME: "PASS" }));
}

export async function readJson<T>(file: string): Promise<T | null> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
export async function atomicJson(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, file); }
export const now = () => new Date().toISOString();
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const composeOfficialUrl = (baseUrl: string, endpoint: string) =>
  new URL(endpoint.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).href;
type HistoricalRecord = { sourceRoute: string; sourceDomain: string; companyCode: string | null; period: string | null; fetchedAt: string; sourceReference: string; rawRowFields?: Record<string, string>; documentLabel?: string; documentReference?: string };
export function buildHistoricalRequest(item: Domain, scope: BackfillScope, baseUrl: string, companyCode?: string) {
  const url = composeOfficialUrl(baseUrl, item.endpoint!); const parameters = new URLSearchParams({ ...(item.staticParameters ?? {}), ...scope.params });
  if (companyCode) parameters.set("co_id", companyCode);
  if (item.id === "MATERIAL_EVENTS_HISTORY" && scope.year && scope.month) { parameters.set("b_date", "01"); parameters.set("e_date", String(new Date(Date.UTC(scope.year, scope.month, 0)).getUTCDate()).padStart(2, "0")); }
  if (item.method === "POST" || item.method === "POST_FORM") return { url, init: { method: "POST", headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "SmartFund private research MOPS historical adapter/1.0" }, body: parameters.toString(), signal: AbortSignal.timeout(30_000) } satisfies RequestInit };
  const target = new URL(url); parameters.forEach((value, key) => target.searchParams.set(key, value)); return { url: target.href, init: { method: "GET", headers: { Accept: item.responseType === "html" ? "text/html" : "application/json", "User-Agent": "SmartFund private research MOPS historical adapter/1.0" }, signal: AbortSignal.timeout(30_000) } satisfies RequestInit };
}
function cleanCell(value: string) { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
export async function decodeMopsResponse(response: Response, _sourceReference: string) { const bytes = await response.arrayBuffer(); const candidates = [new TextDecoder("utf-8").decode(bytes), new TextDecoder("big5").decode(bytes)]; const penalty = (value: string) => [...value].reduce((score, character) => score + (character === "�" ? 100 : /[\uE000-\uF8FF]/u.test(character) ? 10 : character === "嚙" ? 5 : 0), 0); return candidates.sort((left, right) => penalty(left) - penalty(right))[0]; }
function nestedOfficialPost(html: string, sourceReference: string) { const $ = cheerio.load(html); const form = $("form[method='post'],form[method='POST']").filter((_index, element) => /ajax_/i.test($(element).attr("action") ?? "")).first(); if (!form.length) return null; const action = new URL(form.attr("action")!, sourceReference); if (!['mops.twse.com.tw', 'mopsov.twse.com.tw'].includes(action.hostname)) throw new Error("CONTRACT_MISMATCH:NESTED_NON_OFFICIAL_HOST"); const body = new URLSearchParams(); form.find("input[name]").each((_index, input) => body.append($(input).attr("name")!, $(input).attr("value") ?? "")); return { url: action.href, body: body.toString() }; }
export function normalizeHistoricalHtml(item: Domain, sourceReference: string, html: string, fetchedAt: string, companyCode: string | null, period: string | null) {
  if (!/<html|<table|<body/i.test(html)) throw new Error("PARSE_FAILED:NOT_HTML");
  const $ = cheerio.load(html); const pageText = cleanCell($("body").text());
  if (/系統忙碌|查詢發生錯誤|無權限|請先登入|access denied/i.test(pageText)) throw new Error("CONTRACT_MISMATCH:ERROR_PAGE");
  const signatures: Partial<Record<string, RegExp>> = { MONTHLY_REVENUE_HISTORY: /營業收入/, OWNERSHIP_DIRECTOR_HISTORY: /持股/, MATERIAL_EVENTS_HISTORY: /公司代號.*發言日期.*主旨/s };
  if (signatures[item.id] && !signatures[item.id]!.test(pageText)) throw new Error("PARSE_FAILED:CHARSET_OR_CONTRACT_MISMATCH");
  const records: HistoricalRecord[] = [];
  $("table").each((_tableIndex, table) => {
    const rows: string[][] = []; $(table).find("tr").each((_rowIndex, row) => { rows.push($(row).find("th,td").map((_cellIndex, cell) => cleanCell($(cell).text())).get()); });
    const usable = rows.filter((row) => row.some(Boolean)); if (usable.length < 2) return; const headers = usable[0].map((header, index) => header || `column_${index + 1}`);
    for (const row of usable.slice(1)) { if (!row.some(Boolean)) continue; const rawRowFields = Object.fromEntries(row.map((value, index) => [headers[index] ?? `column_${index + 1}`, value])); records.push({ sourceRoute: item.endpoint!, sourceDomain: item.domain, companyCode, period, fetchedAt, sourceReference, rawRowFields }); }
  });
  const documentReferences: HistoricalRecord[] = []; const seen = new Set<string>();
  $("a[href]").each((_index, anchor) => { const label = cleanCell($(anchor).text()); const href = $(anchor).attr("href"); if (!href || !label || !/年報|財務報告|公開說明書|預測|下載|查閱|PDF/i.test(`${label} ${href}`)) return; let absolute: string; try { absolute = new URL(href, sourceReference).href; } catch { return; } if (seen.has(absolute)) return; seen.add(absolute); documentReferences.push({ sourceRoute: item.endpoint!, sourceDomain: item.domain, companyCode, period, fetchedAt, sourceReference, documentLabel: label, documentReference: absolute }); });
  for (const match of html.replaceAll("&amp;", "&").matchAll(/https?:\/\/(?:doc|mops(?:ov)?)\.twse\.com\.tw\/[^"'<>\s)]+/gi)) { const absolute = match[0]; if (seen.has(absolute)) continue; seen.add(absolute); documentReferences.push({ sourceRoute: item.endpoint!, sourceDomain: item.domain, companyCode, period, fetchedAt, sourceReference, documentLabel: "Official document result", documentReference: absolute }); }
  if (!records.length && !documentReferences.length) {
    if (/查無(?:需求|所需)?資料|無符合條件|(?:尚未|無)申報|無資料/i.test(pageText)) return { status: "SOURCE_EMPTY" as const, records: [], documentReferences: [] };
    const wrapperReferences: HistoricalRecord[] = []; $("form[action]").each((_index, form) => { const action = $(form).attr("action"); if (!action || !/ajax_/i.test(action)) return; wrapperReferences.push({ sourceRoute: item.endpoint!, sourceDomain: item.domain, companyCode, period, fetchedAt, sourceReference, documentLabel: "Official nested result form", documentReference: new URL(action, sourceReference).href }); });
    if (wrapperReferences.length) return { status: "PARTIAL" as const, records: [], documentReferences: wrapperReferences };
    throw new Error("PARSE_FAILED:NO_TABLE_OR_DOCUMENT_REFERENCE");
  }
  return { status: "PARSED" as const, records, documentReferences };
}
async function runHistoricalSmoke(registry: Registry) {
  const smokeRoot = path.join(runtimeRoot, "historical-smoke");
  const cases: Array<{ id: string; year: number; month?: number; quarter?: number }> = [
    { id: "MONTHLY_REVENUE_HISTORY", year: 2024, month: 1 },
    { id: "PRODUCT_REVENUE_HISTORY", year: 2024, month: 1 },
    { id: "CORPORATE_INVESTMENT_HISTORY", year: 2024, quarter: 1 },
    { id: "OWNERSHIP_DIRECTOR_HISTORY", year: 2024, month: 1 },
    { id: "GOVERNANCE_INTERNAL_CONTROL_HISTORY", year: 2024 },
    { id: "MATERIAL_EVENTS_HISTORY", year: 2024, month: 1 },
    { id: "INVESTOR_CONFERENCE_HISTORY", year: 2024 },
    { id: "RELATED_PARTY_HISTORY", year: 2024, month: 1 },
    { id: "RELATED_PARTY_QUARTER_HISTORY", year: 2024, quarter: 1 },
    { id: "CAPITAL_FUNDING_HISTORY", year: 2024, month: 1 },
    { id: "OFFICIAL_FINANCIAL_REPORT_HISTORY", year: 2024 },
    { id: "OFFICIAL_ANNUAL_REPORT_HISTORY", year: 2024 },
    { id: "OVERSEAS_INVESTMENT_HISTORY", year: 2024, quarter: 1 },
    { id: "SHAREHOLDING_DISTRIBUTION_HISTORY", year: 2024 },
    { id: "INSIDER_CHANGES_HISTORY", year: 2024, month: 1 },
    { id: "INSIDER_TRANSFER_HISTORY", year: 2024, month: 1 },
    { id: "FOREIGN_OWNERSHIP_HISTORY", year: 2024 },
    { id: "FUNDING_GUARANTEE_DETAIL_HISTORY", year: 2024, month: 1 },
    { id: "ASSET_TRANSACTION_HISTORY", year: 2024, month: 1 },
    { id: "DERIVATIVES_HISTORY", year: 2024, month: 1 },
    { id: "FORECAST_DOCUMENT_HISTORY", year: 2024 },
  ];
  const results: object[] = [];
  const selectedCases = []; for (const testCase of cases) { const alreadyValidated = await readJson(path.join(smokeRoot, `${testCase.id}.json`)); if (historicalSmokeSelection === "REMAINING" ? !alreadyValidated : !historicalSmokeSelection || testCase.id === historicalSmokeSelection) selectedCases.push(testCase); }
  for (const testCase of selectedCases) {
    const item = registry.domains.find((entry) => entry.id === testCase.id); if (!item) throw new Error(`CONTRACT_MISMATCH:MISSING_REGISTRY:${testCase.id}`);
    const scope = createBackfillScopes(item).find((candidate) => candidate.year === testCase.year && candidate.month === testCase.month && candidate.quarter === testCase.quarter); if (!scope) { results.push({ id: item.id, route: item.endpoint, method: item.method, mode: item.backfillMode, http: null, parse: "NOT_RUN", rows: 0, emptyValid: false, documentReferences: 0, status: "CONTRACT_MISMATCH", error: `MISSING_SCOPE:${testCase.id}` }); continue; }
    const request = buildHistoricalRequest(item, scope, registry.baseUrl, "2330"); const fetchedAt = now(); let httpStatus: number | null = null; let responseHtml: string | null = null; let firstPost: number | null = null; let secondPost: number | null = null;
    try {
      const response = await fetch(request.url, request.init); httpStatus = response.status; firstPost = response.status; if (!response.ok) { const failure = { id: item.id, route: item.endpoint, method: item.method, mode: item.backfillMode, http: response.status, firstPost, secondPost, parse: "NOT_RUN", rows: 0, emptyValid: false, documentReferences: 0, status: response.status === 403 || response.status === 429 ? "BLOCKED" : "CONTRACT_MISMATCH", error: `MOPS_HTTP_${response.status}`, fetchedAt }; await mkdir(smokeRoot, { recursive: true }); await writeFile(path.join(smokeRoot, `${item.id}.json`), `${JSON.stringify(failure, null, 2)}\n`, "utf8"); results.push(failure); continue; }
      responseHtml = await decodeMopsResponse(response, request.url); let finalReference = request.url; const nested = nestedOfficialPost(responseHtml, request.url); if (nested && ["INVESTOR_CONFERENCE_HISTORY", "INSIDER_TRANSFER_HISTORY", "ASSET_TRANSACTION_HISTORY"].includes(item.id)) { const nestedResponse = await fetch(nested.url, { method: "POST", headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "SmartFund private research MOPS historical adapter/1.0" }, body: nested.body, signal: AbortSignal.timeout(30_000) }); secondPost = nestedResponse.status; if (!nestedResponse.ok) throw new Error(`CONTRACT_MISMATCH:NESTED_HTTP_${nestedResponse.status}`); responseHtml = await decodeMopsResponse(nestedResponse, nested.url); finalReference = nested.url; if (nestedOfficialPost(responseHtml, nested.url)) throw new Error("CONTRACT_MISMATCH:NESTED_DEPTH_EXCEEDED"); }
      const normalized = normalizeHistoricalHtml(item, finalReference, responseHtml, fetchedAt, "2330", testCase.month ? `${testCase.year}-${String(testCase.month).padStart(2, "0")}` : String(testCase.year));
      const contractStatus = normalized.status === "SOURCE_EMPTY" ? "PASS_EMPTY_VALID" : normalized.status === "PARTIAL" ? "BLOCKED" : "PASS"; const artifact = { id: item.id, http: httpStatus, firstPost, secondPost, ...normalized, contractStatus, fetchedAt }; await mkdir(smokeRoot, { recursive: true }); await writeFile(path.join(smokeRoot, `${item.id}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      results.push({ id: item.id, route: item.endpoint, method: item.method, mode: item.backfillMode, http: httpStatus, firstPost, secondPost, parse: normalized.status, rows: normalized.records.length, documentReferences: normalized.documentReferences.length, emptyValid: normalized.status === "SOURCE_EMPTY", status: contractStatus });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); const failure = { id: item.id, route: item.endpoint, method: item.method, mode: item.backfillMode, http: httpStatus, firstPost, secondPost, parse: "FAILED", rows: 0, emptyValid: false, documentReferences: 0, status: message.startsWith("PARSE_FAILED") ? "PARSE_FAILED" : "BLOCKED", error: message, fetchedAt }; await mkdir(smokeRoot, { recursive: true }); await writeFile(path.join(smokeRoot, `${item.id}.json`), `${JSON.stringify(failure, null, 2)}\n`, "utf8"); if (responseHtml && ["PRODUCT_REVENUE_HISTORY", "CORPORATE_INVESTMENT_HISTORY", "INVESTOR_CONFERENCE_HISTORY", "RELATED_PARTY_QUARTER_HISTORY", "OVERSEAS_INVESTMENT_HISTORY", "FOREIGN_OWNERSHIP_HISTORY"].includes(item.id)) await writeFile(path.join(smokeRoot, `${item.id}.response.html`), responseHtml, "utf8"); results.push(failure); }
    await new Promise((resolve) => setTimeout(resolve, registry.minimumRequestIntervalMs));
  }
  console.log(JSON.stringify({ mode: "HISTORICAL_SMOKE", output: path.relative(process.cwd(), smokeRoot).replaceAll("\\", "/"), results }, null, 2));
}
async function reparseHistoricalSmoke(registry: Registry) {
  const smokeRoot = path.join(runtimeRoot, "historical-smoke"); const ids = ["OVERSEAS_INVESTMENT_HISTORY"]; const results = [];
  for (const id of ids) { const item = registry.domains.find((entry) => entry.id === id); if (!item) throw new Error(`CONTRACT_MISMATCH:MISSING_REGISTRY:${id}`); const html = await readFile(path.join(smokeRoot, `${id}.response.html`), "utf8"); const prior = await readJson<{ http?: number; fetchedAt?: string }>(path.join(smokeRoot, `${id}.json`)); const fetchedAt = prior?.fetchedAt ?? now(); const normalized = normalizeHistoricalHtml(item, item.endpoint!, html, fetchedAt, "2330", "2024"); const status = normalized.status === "SOURCE_EMPTY" ? "PASS_EMPTY_VALID" : normalized.status === "PARTIAL" ? "PARTIAL" : "PASS"; const artifact = { id, http: prior?.http ?? 200, ...normalized, contractStatus: status, fetchedAt }; await writeFile(path.join(smokeRoot, `${id}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8"); results.push({ id, http: artifact.http, parse: normalized.status, rows: normalized.records.length, emptyValid: normalized.status === "SOURCE_EMPTY", documentReferences: normalized.documentReferences.length, status }); }
  console.log(JSON.stringify({ mode: "HISTORICAL_SMOKE_REPARSE", results }, null, 2));
}
function normalizePayload(item: Domain, sourceReference: string, payload: string, fetchedAt: string) {
  if (item.responseType !== "html") {
    const parsed = JSON.parse(payload);
    return { content: payload, records: Array.isArray(parsed) ? parsed.length : Array.isArray(parsed.data) ? parsed.data.length : 1 };
  }
  const $ = cheerio.load(payload); const pattern = new RegExp(item.linkPattern ?? ".+"); const seen = new Set<string>(); const records: object[] = [];
  $("a[href]").each((_index, element) => { const label = $(element).text().replace(/\s+/g, " ").trim(); const rawHref = $(element).attr("href"); if (!rawHref || !pattern.test(label)) return; const officialUrl = new URL(rawHref, sourceReference).href; const key = `${label}|${officialUrl}`; if (seen.has(key)) return; seen.add(key); records.push({ companyIdentifier: null, ticker: null, source: "TWSE_MOPS_OFFICIAL", sourceReference: officialUrl, documentOrEventId: new URL(officialUrl).pathname.split("/").at(-1) ?? null, period: null, announcementOrReportDate: null, fetchedAt, title: label }); });
  $("form[action]").each((_index, element) => { const action = new URL($(element).attr("action")!, sourceReference).href; if (!pattern.test(action) && !action.includes(item.endpoint?.split("/").at(-1) ?? "__NONE__")) return; const key = `FORM|${action}`; if (seen.has(key)) return; seen.add(key); records.push({ companyIdentifier: null, ticker: null, source: "TWSE_MOPS_OFFICIAL", sourceReference: action, documentOrEventId: action.split("/").at(-1) ?? null, period: null, announcementOrReportDate: null, fetchedAt, method: ($(element).attr("method") ?? "get").toUpperCase(), fields: $(element).find("[name]").map((_i, field) => $(field).attr("name")).get() }); });
  if (!records.length) throw new Error(`MOPS_HTML_ROUTE_INDEX_EMPTY:${item.id}`);
  return { content: `${JSON.stringify(records, null, 2)}\n`, records: records.length };
}

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
  if (registry.concurrency !== 1) throw new Error("MOPS_CONCURRENCY_MUST_EQUAL_ONE");
  if (historicalSmokeReparse) return reparseHistoricalSmoke(registry);
  if (historicalSmoke) return runHistoricalSmoke(registry);
  if (backfillDryRun) return console.log(JSON.stringify(registry.domains.map((domain) => { const scopes = createBackfillScopes(domain); return { id: domain.id, mode: domain.backfillMode ?? "NONE", scopes: scopes.length, uniqueScopes: new Set(scopes.map((scope) => JSON.stringify(scope.params))).size, firstParams: scopes.at(0)?.params ?? {}, lastParams: scopes.at(-1)?.params ?? {}, resumeKey: scopes.at(-1) ? JSON.stringify(backfillCursorFor(scopes.at(-1)!)) : null }; }), null, 2));
  const prior = await readJson<{ items: QueueItem[] }>(queuePath);
  const priorById = new Map((prior?.items ?? []).map((item) => [item.id, item]));
  const items: QueueItem[] = registry.domains.map((domain) => { const priorItem = priorById.get(domain.id); return { ...priorItem, ...domain, state: domain.status === "READY" && priorItem?.state === "BLOCKED_SOURCE" ? "PENDING" : priorItem?.state ?? (domain.status === "READY" ? "PENDING" : "BLOCKED_SOURCE"), attempts: priorItem?.attempts ?? 0, checkpoint: priorItem?.checkpoint ?? null, nextEligibleAt: priorItem?.nextEligibleAt ?? null, lastError: priorItem?.lastError ?? null, updatedAt: priorItem?.updatedAt ?? now() }; });
  await atomicJson(queuePath, { version: 1, source: registry.source, concurrency: 1, updatedAt: now(), items });
  await atomicJson(checkpointPath, { version: 1, source: registry.source, runState: "SCHEDULED_WAIT", current: null, completed: items.filter((item) => item.state === "COMPLETE").map((item) => item.id), updatedAt: now() });
  if (bootstrapOnly || !apply) return console.log(JSON.stringify({ mode: "STAGING_BOOTSTRAP", queue: items.length, ready: items.filter((item) => item.status === "READY").length, blockedSource: items.filter((item) => item.status !== "READY").length }));
  const candidates = items.filter((item) => item.status === "READY" && item.state !== "COMPLETE" && (!selected || item.domain === selected || item.id === selected));
  if (selected && !candidates.length) throw new Error(`MOPS_DOMAIN_NOT_FOUND_OR_COMPLETE:${selected}`);
  for (const item of candidates) {
    item.state = "RUNNING"; item.attempts += 1; item.updatedAt = now();
    await atomicJson(queuePath, { version: 1, source: registry.source, concurrency: 1, updatedAt: now(), items });
    await atomicJson(checkpointPath, { version: 1, source: registry.source, runState: "RUNNING", current: item.id, completed: items.filter((entry) => entry.state === "COMPLETE").map((entry) => entry.id), updatedAt: now() });
    try {
      const sourceReference = composeOfficialUrl(registry.baseUrl, item.endpoint!);
      const response = await fetch(sourceReference, { headers: { Accept: "application/json", "User-Agent": "SmartFund private research MOPS staging importer/1.0" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`MOPS_HTTP_${response.status}`);
      const payload = await response.text(); const fetchedAt = now(); const normalized = normalizePayload(item, sourceReference, payload, fetchedAt);
      const contentHash = sha256(normalized.content); const objectPath = path.join(runtimeRoot, "objects", `${contentHash}.json`);
      await mkdir(path.dirname(objectPath), { recursive: true }); await writeFile(objectPath, normalized.content, { encoding: "utf8", flag: "wx" }).catch(async (error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
      item.state = "COMPLETE"; item.checkpoint = contentHash; item.lastError = null; item.nextEligibleAt = null; item.updatedAt = fetchedAt;
      await atomicJson(path.join(runtimeRoot, "manifests", `${item.id}.json`), { source: registry.source, domain: item.domain, sourceReference, fetchedAt, contentHash, recordCount: normalized.records, objectPath: path.relative(runtimeRoot, objectPath).replaceAll("\\", "/"), provenance: { source: registry.source, sourceReference, fetchedAt, dataPeriod: null, companyIdentifierField: "source_payload", documentOrEventId: item.id } });
    } catch (error) {
      item.lastError = error instanceof Error ? error.message : String(error); item.updatedAt = now();
      item.state = item.attempts >= registry.maxAttempts ? "BLOCKED_SOURCE" : "RETRY_WAIT";
      item.nextEligibleAt = item.state === "RETRY_WAIT" ? new Date(Date.now() + 60_000 * 2 ** (item.attempts - 1)).toISOString() : null;
    }
    await atomicJson(queuePath, { version: 1, source: registry.source, concurrency: 1, updatedAt: now(), items });
    await new Promise((resolve) => setTimeout(resolve, registry.minimumRequestIntervalMs));
  }
  await atomicJson(checkpointPath, { version: 1, source: registry.source, runState: items.some((item) => item.state === "RETRY_WAIT") ? "RETRY_WAIT" : "SCHEDULED_WAIT", current: null, completed: items.filter((item) => item.state === "COMPLETE").map((item) => item.id), updatedAt: now() });
}

if (path.basename(process.argv[1] ?? "") === "run-isolated-mops-ingestion.ts") {
  if (iteratorSelfTest) runIteratorSelfTest();
  else main().catch(async (error) => { if (!historicalSmoke && !historicalSmokeReparse) await atomicJson(checkpointPath, { version: 1, source: "TWSE_MOPS_OFFICIAL", runState: "BLOCKED", current: null, lastError: error instanceof Error ? error.message : String(error), updatedAt: now() }); throw error; });
}
