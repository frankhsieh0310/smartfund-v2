import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import XLSX from "xlsx";

type Kind = "nominal" | "real";
type Observation = {
  country: "GB"; seriesId: string; tenor: string; observationDate: string; value: number;
  unit: "PERCENT_PER_ANNUM"; curveType: string; source: string; sourceUrl: string;
  fetchedAt: string; publicationDate: null; revisionStatus: string; parserVersion: string;
  qualityStatus: "PASS"; sourceRecordId: string; sourceSha256: string;
};

const RUNTIME = path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"));
const ROOT = path.join(RUNTIME, "bank-of-england");
const RAW = path.join(ROOT, "raw");
const NORMALIZED = path.join(ROOT, "normalized");
const SOURCE_URL = "https://www.bankofengland.co.uk/statistics/yield-curves";
const PARSER_VERSION = "boe-xlsx-spot-v2";
const canary = process.argv.includes("--canary");
const definitions: Array<{ kind: Kind; zip: string; tenors: number[] }> = [
  { kind: "nominal", zip: "glcnominalddata.zip", tenors: [1, 2, 3, 5, 7, 10, 20, 30, 40] },
  { kind: "real", zip: "glcrealddata.zip", tenors: [3, 5, 7, 10, 20, 30, 40] },
];

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function isoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
  }
  return null;
}

async function parse(): Promise<{ rows: Observation[]; conflicts: number; workbooks: number }> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "source-manifest.json"), "utf8")) as { captures: Array<{ kind: Kind; fetchedAt: string; sha256: string }> };
  const byKey = new Map<string, Observation>();
  let conflicts = 0;
  let workbooks = 0;
  for (const definition of definitions) {
    const zipBytes = new Uint8Array(await readFile(path.join(RAW, definition.zip)));
    const outer = unzipSync(zipBytes);
    const entries = Object.entries(outer).filter(([name]) => name.toLowerCase().endsWith(".xlsx") && (!canary || name.includes("2025 to present")));
    const capture = manifest.captures.find((item) => item.kind === definition.kind);
    if (!capture || capture.sha256 !== sha256(zipBytes)) throw new Error(`BOE_SOURCE_CHECKSUM_MISMATCH:${definition.kind}`);
    for (const [workbookName, workbookBytes] of entries) {
      workbooks++;
      const workbook = XLSX.read(Buffer.from(workbookBytes), { type: "buffer", cellDates: false });
      const sheetName = workbook.SheetNames.find((name) => /^4\..*spot curve$/i.test(name.trim()));
      const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
      if (!sheet) throw new Error(`BOE_SPOT_SHEET_MISSING:${workbookName}`);
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const maturities = matrix[3] ?? [];
      const columns = definition.tenors.map((tenor) => ({ tenor, column: maturities.findIndex((value) => Number(value) === tenor) })).filter(({ column }) => column >= 1);
      if (!columns.length) throw new Error(`BOE_TENOR_COLUMNS_MISSING:${workbookName}`);
      for (const row of matrix.slice(5)) {
        const observationDate = isoDate(row[0]);
        if (!observationDate) continue;
        for (const { tenor, column } of columns) {
          if (canary && tenor !== 10) continue;
          const value = Number(row[column]);
          if (!Number.isFinite(value)) continue;
          const family = definition.kind.toUpperCase();
          const seriesId = `BOE_${family}_${tenor}Y`;
          const record: Observation = {
            country: "GB", seriesId, tenor: `${tenor}Y`, observationDate, value,
            unit: "PERCENT_PER_ANNUM", curveType: `${family}_ZERO_COUPON_SPOT`,
            source: "BANK_OF_ENGLAND_GOVERNMENT_LIABILITY_CURVE", sourceUrl: SOURCE_URL,
            fetchedAt: capture.fetchedAt, publicationDate: null, revisionStatus: "CURRENT_OFFICIAL_FILE_VALUE",
            parserVersion: PARSER_VERSION, qualityStatus: "PASS",
            sourceRecordId: `${definition.kind}:${workbookName}:4. spot curve:${observationDate}:${tenor}Y`, sourceSha256: capture.sha256,
          };
          const key = `${seriesId}:${observationDate}`;
          const prior = byKey.get(key);
          if (prior && prior.value !== record.value) conflicts++;
          byKey.set(key, record);
        }
      }
    }
  }
  return { rows: [...byKey.values()].sort((a, b) => a.seriesId.localeCompare(b.seriesId) || a.observationDate.localeCompare(b.observationDate)), conflicts, workbooks };
}

async function main(): Promise<void> {
  await mkdir(NORMALIZED, { recursive: true });
  const result = await parse();
  const series = new Set(result.rows.map((row) => row.seriesId));
  const output = { country: "GB", generatedAt: new Date().toISOString(), parserVersion: PARSER_VERSION, conflicts: result.conflicts, rows: result.rows };
  const file = path.join(NORMALIZED, canary ? "canary.json" : "observations.json");
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  await writeFile(file, serialized, "utf8");
  const readBack = JSON.parse(await readFile(file, "utf8")) as { rows: Observation[] };
  const stable = sha256(serialized) === sha256(`${JSON.stringify(output, null, 2)}\n`);
  const expectedSeries = canary ? 2 : 16;
  if (series.size !== expectedSeries || readBack.rows.length !== result.rows.length || result.conflicts !== 0 || !stable) throw new Error("BOE_NORMALIZATION_ACCEPTANCE_FAILED");
  console.log(JSON.stringify({ status: "PASS", mode: canary ? "CANARY" : "FULL_BOUNDED", series: series.size, rows: result.rows.length, workbooks: result.workbooks, conflicts: result.conflicts, readBack: "PASS", idempotency: "PASS", file }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
