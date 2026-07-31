import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { chromium, type Browser } from "playwright";

export type YahooHistoryRow = {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjustedClose: number | null;
  volume: number | null;
};

export type YahooRejectedRow = { index: number; reason: string; cells: string[] };

export type YahooHtmlResponse = {
  url: string;
  status: number;
  contentType: string | null;
  responseSize: number;
  checksum: string;
  fetchDurationMs: number;
  html: string;
};

const CHROMIUM_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const empty = new Set(["", "-", "--", "null", "n/a", "na"]);

const cleanHeader = (value: string) => value.replace(/[\s\u00a0]/g, "").toLowerCase();
const parseNumber = (value: string): number | null => {
  const cleaned = value.replace(/,/g, "").trim();
  if (empty.has(cleaned.toLowerCase())) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

function parseDate(value: string): Date | null {
  const chinese = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chinese) {
    const [, year, month, day] = chinese;
    return new Date(`${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T00:00:00.000Z`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function columnIndexes(headers: string[]) {
  const index = (predicate: (header: string) => boolean) => headers.findIndex(predicate);
  return {
    date: index((header) => header === "date" || header.includes("日期")),
    open: index((header) => header === "open" || header.includes("開市") || header.includes("開盤")),
    high: index((header) => header === "high" || header.includes("最高")),
    low: index((header) => header === "low" || header.includes("最低")),
    close: index((header) => header === "close" || header.includes("關閉") || header.includes("收市價")),
    adjustedClose: index((header) => header.includes("adjclose") || header.includes("adjustedclose") || header.includes("調整後的收市價")),
    volume: index((header) => header === "volume" || header.includes("成交量")),
  };
}

export class YahooHtmlHistoryProvider {
  private browser: Browser | null = null;

  checkReady() {
    return { provider: "YAHOO_HTML", userAgent: CHROMIUM_USER_AGENT, requiresCookie: false, requiresCrumb: false };
  }

  buildUrl(symbol: string, period1: number, period2: number) {
    return `https://hk.finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/?period1=${period1}&period2=${period2}`;
  }

  async fetchHistory(symbol: string, period1: number, period2: number): Promise<YahooHtmlResponse> {
    const url = this.buildUrl(symbol, period1, period2);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.fetchWithChromium(url);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
    throw new Error(`YAHOO_HTML_FETCH_FAILED:${lastError?.message ?? "unknown"}`);
  }

  private async fetchWithChromium(url: string): Promise<YahooHtmlResponse> {
    const startedAt = Date.now();
    if (this.browser && !this.browser.isConnected()) this.browser = null;
    this.browser ??= await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ userAgent: CHROMIUM_USER_AGENT, locale: "zh-HK" });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("table", { timeout: 20_000 });
      const html = await page.content();
      const result = {
        url,
        status: response?.status() ?? 0,
        contentType: response?.headers()["content-type"] ?? null,
        responseSize: Buffer.byteLength(html),
        checksum: createHash("sha256").update(html).digest("hex"),
        fetchDurationMs: Date.now() - startedAt,
        html,
      };
      if (!response?.ok() || !result.contentType?.includes("text/html")) throw new Error(`YAHOO_HTML_HTTP_${result.status}:${result.contentType ?? "unknown"}`);
      return result;
    } finally {
      await context.close();
    }
  }

  async close() {
    await this.browser?.close();
    this.browser = null;
  }

  parseHistoryHtml(html: string) {
    const $ = cheerio.load(html);
    const tables = $("table").toArray();
    for (const table of tables) {
      const headers = $(table).find("th").toArray().map((cell) => cleanHeader($(cell).text()));
      const columns = columnIndexes(headers);
      if (columns.date < 0 || columns.open < 0 || columns.high < 0 || columns.low < 0 || columns.close < 0 || columns.volume < 0) continue;
      const sourceRows = $(table).find("tbody tr").toArray().map((row) => $(row).find("td").toArray().map((cell) => $(cell).text().replace(/\s+/g, " ").trim()));
      const rows: YahooHistoryRow[] = [];
      const rejected: YahooRejectedRow[] = [];
      sourceRows.forEach((cells, index) => {
        const date = parseDate(cells[columns.date] ?? "");
        const open = parseNumber(cells[columns.open] ?? "");
        const high = parseNumber(cells[columns.high] ?? "");
        const low = parseNumber(cells[columns.low] ?? "");
        const close = parseNumber(cells[columns.close] ?? "");
        if (!date || (open === null && high === null && low === null && close === null) || close === null) {
          rejected.push({ index, reason: "INVALID_OR_NON_PRICE_ROW", cells });
          return;
        }
        // Yahoo's history table renders a legitimate zero-volume session as "-".
        // Preserve the raw HTML artifact, but normalize the canonical numeric value
        // to zero so it agrees with Yahoo Chart and remains valid OHLCV.
        rows.push({ date, open, high, low, close, adjustedClose: columns.adjustedClose < 0 ? null : parseNumber(cells[columns.adjustedClose] ?? ""), volume: parseNumber(cells[columns.volume] ?? "") ?? 0 });
      });
      return { headers, sourceRows: sourceRows.length, rows, rejected };
    }
    throw new Error("YAHOO_HTML_HISTORY_TABLE_NOT_FOUND");
  }

  normalizeRows(rows: YahooHistoryRow[]) {
    const unique = new Map<string, YahooHistoryRow>();
    for (const row of rows) unique.set(row.date.toISOString().slice(0, 10), row);
    return [...unique.values()].sort((left, right) => left.date.valueOf() - right.date.valueOf());
  }
}
