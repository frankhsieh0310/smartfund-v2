import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield")), "us-treasury");
const CHECKPOINT = path.join(ROOT, "checkpoint.json");
const FAILURES = path.join(ROOT, "failures.jsonl");
const PARSER_VERSION = "us-treasury-atom-v1";
const CURRENT_YEAR = new Date().getUTCFullYear();
const incremental = process.argv.includes("--incremental");
const START_YEAR = Number(process.env.GOVERNMENT_YIELD_US_START_YEAR ?? "1990");
const TENORS: Record<string, string> = {
  BC_1MONTH: "1M", BC_3MONTH: "3M", BC_6MONTH: "6M", BC_1YEAR: "1Y",
  BC_2YEAR: "2Y", BC_3YEAR: "3Y", BC_5YEAR: "5Y", BC_7YEAR: "7Y",
  BC_10YEAR: "10Y", BC_20YEAR: "20Y", BC_30YEAR: "30Y"
};
const REAL_TENORS: Record<string, string> = {
  TC_5YEAR: "5Y", TC_7YEAR: "7Y", TC_10YEAR: "10Y", TC_20YEAR: "20Y", TC_30YEAR: "30Y"
};

type Observation = {
  country: "US"; seriesId: string; tenor: string; observationDate: string; value: number;
  unit: "PERCENT_PER_ANNUM"; curveType: "PAR_YIELD" | "REAL_PAR_YIELD"; source: string;
  sourceUrl: string; fetchedAt: string; publicationDate: null; revisionStatus: string;
  parserVersion: string; qualityStatus: "PASS";
};

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function properties(xml: string): Array<Record<string, string>> {
  return [...xml.matchAll(/<m:properties>([\s\S]*?)<\/m:properties>/g)].map((entry) => {
    const row: Record<string, string> = {};
    for (const field of entry[1].matchAll(/<d:([A-Z0-9_]+)(?:\s[^>]*)?>([^<]*)<\/d:\1>/g)) row[field[1]] = field[2];
    return row;
  });
}

function normalize(xml: string, url: string, real: boolean, fetchedAt: string): Observation[] {
  const tenorMap = real ? REAL_TENORS : TENORS;
  const curveType = real ? "REAL_PAR_YIELD" : "PAR_YIELD";
  const source = real ? "US_TREASURY_DAILY_REAL_YIELD_CURVE" : "US_TREASURY_DAILY_PAR_YIELD_CURVE";
  return properties(xml).flatMap((row) => {
    const date = row.NEW_DATE?.slice(0, 10);
    if (!date) return [];
    return Object.entries(tenorMap).flatMap(([field, tenor]) => {
      const value = Number(row[field]);
      if (!Number.isFinite(value)) return [];
      return [{ country: "US", seriesId: `${real ? "UST_REAL" : "UST_PAR"}_${tenor}`, tenor, observationDate: date, value,
        unit: "PERCENT_PER_ANNUM", curveType, source, sourceUrl: url, fetchedAt, publicationDate: null,
        revisionStatus: "CURRENT_OFFICIAL_FEED_VALUE", parserVersion: PARSER_VERSION, qualityStatus: "PASS" } satisfies Observation];
    });
  });
}

async function fetchYear(year: number, real: boolean): Promise<{ xml: string; url: string }> {
  const data = real ? "daily_treasury_real_yield_curve" : "daily_treasury_yield_curve";
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=${data}&field_tdr_date_value=${year}`;
  const response = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": "SmartFund Government Yield/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`BLOCKED_SOURCE_ACCESS:${response.status}`);
  return { xml: await response.text(), url };
}

async function main(): Promise<void> {
  await mkdir(path.join(ROOT, "raw"), { recursive: true });
  await mkdir(path.join(ROOT, "normalized"), { recursive: true });
  let totalRows = 0;
  let completedFiles = 0;
  for (let year = START_YEAR; year <= CURRENT_YEAR; year += 1) {
    for (const real of [false, true]) {
      if (real && year < 2003) continue;
      const kind = real ? "real" : "nominal";
      const normalizedPath = path.join(ROOT, "normalized", `${year}-${kind}.json`);
      try {
        const prior = JSON.parse(await readFile(normalizedPath, "utf8")) as { rows: Observation[] };
        if (!(incremental && year === CURRENT_YEAR)) {
          totalRows += prior.rows.length;
          completedFiles += 1;
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        const fetchedAt = new Date().toISOString();
        const { xml, url } = await fetchYear(year, real);
        const rows = normalize(xml, url, real, fetchedAt);
        if (!rows.length && year <= CURRENT_YEAR) throw new Error("PARSE_FAILURE:NO_OBSERVATIONS");
        await writeFile(path.join(ROOT, "raw", `${year}-${kind}.xml`), xml, "utf8");
        await writeFile(normalizedPath, `${JSON.stringify({ country: "US", year, kind, sourceUrl: url, fetchedAt, sourceSha256: sha256(xml), parserVersion: PARSER_VERSION, rows }, null, 2)}\n`, "utf8");
        totalRows += rows.length;
        completedFiles += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendFile(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), country: "US", year, kind, reasonCode: message.split(":")[0], message, retryable: /TIMEOUT|ACCESS/.test(message) })}\n`, "utf8");
      }
      await writeFile(CHECKPOINT, `${JSON.stringify({ asset: "GOVERNMENT_YIELD", layer: "L4_OFFICIAL_HISTORICAL", country: "US", year, kind, completedFiles, totalRows, updatedAt: new Date().toISOString(), continuing: true }, null, 2)}\n`, "utf8");
    }
  }
  await writeFile(CHECKPOINT, `${JSON.stringify({ asset: "GOVERNMENT_YIELD", layer: "L4_OFFICIAL_HISTORICAL", country: "US", status: "COMPLETED_WITH_GAPS", completedFiles, totalRows, updatedAt: new Date().toISOString(), next: "EA", continuing: true }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "COMPLETED_WITH_GAPS", country: "US", completedFiles, totalRows, next: "EA" }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
