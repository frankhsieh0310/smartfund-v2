import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield")), "japan-mof");
const URL = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv";
const PARSER_VERSION = "japan-mof-jgbcme-v1";
const TENORS = ["1Y", "2Y", "3Y", "4Y", "5Y", "6Y", "7Y", "8Y", "9Y", "10Y", "15Y", "20Y", "25Y", "30Y", "40Y"];

async function main(): Promise<void> {
  await mkdir(path.join(ROOT, "raw"), { recursive: true });
  await mkdir(path.join(ROOT, "normalized"), { recursive: true });
  const fetchedAt = new Date().toISOString();
  const response = await fetch(URL, { headers: { Accept: "text/csv", "User-Agent": "SmartFund Government Yield/1.0" }, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`BLOCKED_SOURCE_ACCESS:${response.status}`);
  const csv = await response.text();
  const rows = csv.split(/\r?\n/).slice(2).flatMap((line) => {
    const fields = line.split(",");
    const match = fields[0]?.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!match) return [];
    const observationDate = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return TENORS.flatMap((tenor, index) => {
      const value = Number(fields[index + 1]);
      if (!Number.isFinite(value)) return [];
      return [{ country: "JP", seriesId: `JGB_CMT_${tenor}`, tenor, observationDate, value,
        unit: "PERCENT_PER_ANNUM", curveType: "PAR_CONSTANT_MATURITY", source: "JAPAN_MOF_JGB_INTEREST_RATE",
        sourceUrl: URL, fetchedAt, publicationDate: null, revisionStatus: "CURRENT_OFFICIAL_FILE_VALUE",
        parserVersion: PARSER_VERSION, qualityStatus: "PASS" }];
    });
  });
  if (!rows.length) throw new Error("PARSE_FAILURE:NO_OBSERVATIONS");
  await writeFile(path.join(ROOT, "raw", "jgbcme_all.csv"), csv, "utf8");
  await writeFile(path.join(ROOT, "normalized", "observations.json"), `${JSON.stringify({ country: "JP", sourceUrl: URL, fetchedAt, sourceSha256: createHash("sha256").update(csv).digest("hex"), parserVersion: PARSER_VERSION, rows }, null, 2)}\n`, "utf8");
  await writeFile(path.join(ROOT, "checkpoint.json"), `${JSON.stringify({ asset: "GOVERNMENT_YIELD", layer: "L4_OFFICIAL_HISTORICAL", country: "JP", status: "COMPLETED", series: TENORS.length, totalRows: rows.length, updatedAt: fetchedAt, next: "GB", continuing: true }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "COMPLETED", country: "JP", series: TENORS.length, totalRows: rows.length, next: "GB" }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
