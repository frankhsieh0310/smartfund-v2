import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE = "TPEx_GOVERNMENT_BOND_DAILY_OUTRIGHT" as const;
export const TAIWAN_GOVERNMENT_BOND_SECONDARY_DISCOVERY_ENDPOINT = "https://www.tpex.org.tw/www/zh-tw/bond/govDaily";
export const TAIWAN_GOVERNMENT_BOND_SECONDARY_PARSER_VERSION = "1.0.0";
export const TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID = "official-bond-taiwan-government-secondary-historical";

export type TaiwanGovernmentBondSecondaryReport = {
  date: string;
  displayDate: string;
  xlsUrl: string;
  odsUrl: string;
};

export type TaiwanGovernmentBondSecondaryObservation = {
  sourceNamespace: typeof TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE;
  officialSecurityId: string;
  name: string;
  observationDate: string;
  duration: string | null;
  remainingYears: string | null;
  priceLow: string | null;
  priceHigh: string | null;
  priceAverage: string | null;
  priceChange: string | null;
  price1155To1200Average: string | null;
  yieldHigh: string | null;
  yieldLow: string | null;
  yieldVolumeWeightedAverage: string | null;
  yieldChange: string | null;
  yield1155To1200Average: string | null;
  tradingValueTwd: string | null;
  tradingFaceValueHundredMillionTwd: string | null;
  sourceDocumentId: string;
  rawPayloadHash: string;
  importedAt: string;
};

function htmlCells(row: string): string[][] {
  return (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) ?? []).map((cell) => {
    const withLines = cell.replace(/<br\s*\/?\s*>/gi, "\n");
    return decodeXml(withLines.replace(/<[^>]+>/g, " "))
      .split("\n")
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  });
}

export function parseTaiwanGovernmentBondSecondaryLegacyHtml(
  htmlBytes: Buffer,
  observationDate: string,
  importedAt = new Date().toISOString(),
): { observations: TaiwanGovernmentBondSecondaryObservation[]; sourceHash: string } {
  const sourceHash = sha256(htmlBytes);
  const html = new TextDecoder("big5").decode(htmlBytes);
  const observations: TaiwanGovernmentBondSecondaryObservation[] = [];
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = htmlCells(row);
    const officialSecurityId = cells[0]?.[0]?.trim();
    if (!officialSecurityId || !/^[AH][A-Z0-9]{5}$/.test(officialSecurityId) || cells.length < 11) continue;
    observations.push({
      sourceNamespace: TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE,
      officialSecurityId,
      name: cells[1]?.[0] ?? "",
      observationDate,
      duration: normalizedDecimal(cells[2]?.[0]),
      remainingYears: normalizedDecimal(cells[3]?.[0]),
      priceLow: normalizedDecimal(cells[5]?.[0]),
      priceHigh: normalizedDecimal(cells[6]?.[0]),
      priceAverage: normalizedDecimal(cells[7]?.[0]),
      priceChange: normalizedDecimal(cells[8]?.[0]),
      price1155To1200Average: null,
      yieldHigh: normalizedDecimal(cells[5]?.[1]),
      yieldLow: normalizedDecimal(cells[6]?.[1]),
      yieldVolumeWeightedAverage: normalizedDecimal(cells[7]?.[1]),
      yieldChange: normalizedDecimal(cells[8]?.[1]),
      yield1155To1200Average: null,
      tradingValueTwd: normalizedDecimal(cells[9]?.[0]),
      tradingFaceValueHundredMillionTwd: normalizedDecimal(cells[10]?.[0]),
      sourceDocumentId: `DYS01:${observationDate}`,
      rawPayloadHash: sourceHash,
      importedAt,
    });
  }
  const duplicateKeys = observations.length - new Set(observations.map((row) => row.officialSecurityId)).size;
  if (duplicateKeys) throw new Error(`TPEX_TW_BOND_SECONDARY_LEGACY_DUPLICATES:${observationDate}:${duplicateKeys}`);
  return { observations, sourceHash };
}

type DiscoveryPayload = {
  stat?: string;
  tables?: Array<{ data?: string[][] }>;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .trim();
}

function normalizedDecimal(value: string | undefined): string | null {
  const normalized = String(value ?? "")
    .replaceAll(",", "")
    .replaceAll("−", "-")
    .replace(/\s+/g, "")
    .trim();
  if (!normalized || normalized === "-" || normalized === "--") return null;
  return Number.isFinite(Number(normalized)) ? normalized : null;
}

function zipEntry(buffer: Buffer, requestedName: string): Buffer {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = Math.max(0, buffer.length - 65_557); offset <= buffer.length - 22; offset += 1) {
    if (buffer.readUInt32LE(offset) === endSignature) endOffset = offset;
  }
  if (endOffset < 0) throw new Error("TPEX_TW_BOND_ODS_END_RECORD_NOT_FOUND");
  const entries = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("TPEX_TW_BOND_ODS_CENTRAL_DIRECTORY_INVALID");
    const compression = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const filenameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const filename = buffer.subarray(centralOffset + 46, centralOffset + 46 + filenameLength).toString("utf8");
    if (filename === requestedName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("TPEX_TW_BOND_ODS_LOCAL_HEADER_INVALID");
      const localFilenameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localFilenameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      if (compression === 0) return Buffer.from(compressed);
      if (compression === 8) return inflateRawSync(compressed);
      throw new Error(`TPEX_TW_BOND_ODS_COMPRESSION_UNSUPPORTED:${compression}`);
    }
    centralOffset += 46 + filenameLength + extraLength + commentLength;
  }
  throw new Error(`TPEX_TW_BOND_ODS_ENTRY_NOT_FOUND:${requestedName}`);
}

function parseRows(contentXml: string): string[][] {
  const rows: string[][] = [];
  for (const row of contentXml.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g) ?? []) {
    const values: string[] = [];
    for (const cell of row.match(/<table:table-cell\b[^>]*(?:\/>|>[\s\S]*?<\/table:table-cell>)/g) ?? []) {
      const repeated = Number.parseInt(cell.match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? "1", 10);
      const paragraphs = cell.match(/<text:p\b[^>]*>[\s\S]*?<\/text:p>/g) ?? [];
      const value = decodeXml(paragraphs
        .map((paragraph) => paragraph.replace(/<[^>]+>/g, ""))
        .join(" ")
        .replace(/\s+/g, " "));
      for (let count = 0; count < Math.min(repeated, 64); count += 1) values.push(value);
    }
    rows.push(values);
  }
  return rows;
}

export function parseTaiwanGovernmentBondSecondaryOds(
  ods: Buffer,
  report: TaiwanGovernmentBondSecondaryReport,
  allowedSecurityIds: ReadonlySet<string>,
  importedAt = new Date().toISOString(),
): { observations: TaiwanGovernmentBondSecondaryObservation[]; excludedSecurityIds: string[]; unregisteredHistoricalSecurityIds: string[]; sourceHash: string } {
  const sourceHash = sha256(ods);
  const rows = parseRows(zipEntry(ods, "content.xml").toString("utf8"));
  const observations: TaiwanGovernmentBondSecondaryObservation[] = [];
  const excludedSecurityIds = new Set<string>();
  const unregisteredHistoricalSecurityIds = new Set<string>();
  for (const cells of rows) {
    const officialSecurityId = cells[0]?.trim();
    if (!officialSecurityId || !/^[A-Z0-9]{6}$/.test(officialSecurityId) || cells.length < 16) continue;
    const governmentSecurity = allowedSecurityIds.has(officialSecurityId) || /^[AH][A-Z0-9]{5}$/.test(officialSecurityId);
    if (!governmentSecurity) {
      excludedSecurityIds.add(officialSecurityId);
      continue;
    }
    if (!allowedSecurityIds.has(officialSecurityId)) unregisteredHistoricalSecurityIds.add(officialSecurityId);
    observations.push({
      sourceNamespace: TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE,
      officialSecurityId,
      name: cells[1]?.trim() ?? "",
      observationDate: report.date,
      duration: normalizedDecimal(cells[2]),
      remainingYears: normalizedDecimal(cells[3]),
      priceLow: normalizedDecimal(cells[4]),
      priceHigh: normalizedDecimal(cells[5]),
      priceAverage: normalizedDecimal(cells[6]),
      priceChange: normalizedDecimal(cells[7]),
      price1155To1200Average: normalizedDecimal(cells[8]),
      yieldHigh: normalizedDecimal(cells[9]),
      yieldLow: normalizedDecimal(cells[10]),
      yieldVolumeWeightedAverage: normalizedDecimal(cells[11]),
      yieldChange: normalizedDecimal(cells[12]),
      yield1155To1200Average: normalizedDecimal(cells[13]),
      tradingValueTwd: normalizedDecimal(cells[14]),
      tradingFaceValueHundredMillionTwd: normalizedDecimal(cells[15]),
      sourceDocumentId: `BDdys01a:${report.date}`,
      rawPayloadHash: sourceHash,
      importedAt,
    });
  }
  const duplicateKeys = observations.length - new Set(observations.map((row) => `${row.officialSecurityId}:${row.observationDate}`)).size;
  if (duplicateKeys) throw new Error(`TPEX_TW_BOND_SECONDARY_DUPLICATES:${report.date}:${duplicateKeys}`);
  return {
    observations,
    excludedSecurityIds: [...excludedSecurityIds].sort(),
    unregisteredHistoricalSecurityIds: [...unregisteredHistoricalSecurityIds].sort(),
    sourceHash,
  };
}

export class TaiwanGovernmentBondSecondaryMarketAdapter {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: { timeoutMs?: number; maxRetries?: number; userAgent?: string } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.userAgent = options.userAgent ?? process.env.SMARTFUND_DATA_USER_AGENT ?? "SmartFund/1.0 official-data adapter";
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          headers: { "User-Agent": this.userAgent, ...(init?.headers ?? {}) },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`TPEX_TW_BOND_SECONDARY_HTTP_${response.status}:${url}`);
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async discoverMonth(month: string): Promise<TaiwanGovernmentBondSecondaryReport[]> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`TPEX_TW_BOND_SECONDARY_MONTH_INVALID:${month}`);
    const body = new URLSearchParams({ date: `${month.replace("-", "/")}/01`, fileCode: "BDdys01a", response: "json" });
    const response = await this.request(TAIWAN_GOVERNMENT_BOND_SECONDARY_DISCOVERY_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
    });
    const payload = await response.json() as DiscoveryPayload;
    if (payload.stat !== "ok") throw new Error(`TPEX_TW_BOND_SECONDARY_DISCOVERY_FAILED:${month}`);
    const rows = payload.tables?.flatMap((table) => table.data ?? []) ?? [];
    return rows.map((row) => {
      const match = row[1]?.match(/BDdys01a\.(\d{8})-C\.xls$/);
      if (!match || !row[2]) throw new Error(`TPEX_TW_BOND_SECONDARY_DISCOVERY_ROW_INVALID:${JSON.stringify(row)}`);
      const yyyymmdd = match[1];
      return {
        date: `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`,
        displayDate: row[0],
        xlsUrl: new URL(row[1], "https://www.tpex.org.tw").toString(),
        odsUrl: new URL(`/www${row[2]}`, "https://www.tpex.org.tw").toString(),
      };
    }).sort((left, right) => left.date.localeCompare(right.date));
  }

  async fetchOds(report: TaiwanGovernmentBondSecondaryReport): Promise<Buffer> {
    const response = await this.request(report.odsUrl, { headers: { Accept: "application/vnd.oasis.opendocument.spreadsheet" } });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error(`TPEX_TW_BOND_SECONDARY_ODS_INVALID:${report.date}`);
    return bytes;
  }

  async fetchLegacyHtml(date: string): Promise<{ url: string; bytes: Buffer } | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`TPEX_TW_BOND_SECONDARY_LEGACY_DATE_INVALID:${date}`);
    const [year, month, day] = date.split("-").map(Number);
    const roc = year - 1911;
    const code = `${String(roc).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
    const url = `https://hist.tpex.org.tw/HIST/BOND_TRADING_INFO/GOV_BOND/30/30_${code}.HTML`;
    const response = await fetch(url, {
      headers: { Accept: "text/html", "User-Agent": this.userAgent },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`TPEX_TW_BOND_SECONDARY_LEGACY_HTTP_${response.status}:${date}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("latin1");
    if (/nodata\.htm/i.test(response.url) || !/table-body-right/i.test(text)) return null;
    return { url, bytes };
  }
}
