import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield")), "ecb-euro-area");
const CHECKPOINT = path.join(ROOT, "checkpoint.json");
const FAILURES = path.join(ROOT, "failures.jsonl");
const TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"];
const PARSER_VERSION = "ecb-yc-csv-v1";
const incremental = process.argv.includes("--incremental");
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

async function main(): Promise<void> {
  await mkdir(path.join(ROOT, "raw"), { recursive: true });
  await mkdir(path.join(ROOT, "normalized"), { recursive: true });
  let totalRows = 0;
  let completed = 0;
  for (const tenor of TENORS) {
    const normalizedPath = path.join(ROOT, "normalized", `${tenor}.json`);
    try {
      const prior = JSON.parse(await readFile(normalizedPath, "utf8")) as { rows: unknown[] };
      if (!incremental) { totalRows += prior.rows.length; completed += 1; continue; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const dataType = `SR_${tenor}`;
    const key = `B.U2.EUR.4F.G_N_C.SV_C_YM.${dataType}`;
    const url = `https://data-api.ecb.europa.eu/service/data/YC/${key}?format=csvdata`;
    try {
      const fetchedAt = new Date().toISOString();
      const response = await fetch(url, { headers: { Accept: "text/csv", "User-Agent": "SmartFund Government Yield/1.0" }, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`BLOCKED_SOURCE_ACCESS:${response.status}`);
      const csv = await response.text();
      const rows = csv.split(/\r?\n/).slice(1).flatMap((line) => {
        if (!line) return [];
        const fields = line.split(",", 10);
        const value = Number(fields[9]);
        if (fields[0] !== `YC.${key}` || !/^\d{4}-\d{2}-\d{2}$/.test(fields[8]) || !Number.isFinite(value)) return [];
        return [{ country: "EA", seriesId: `ECB_YC_ALL_${tenor}`, tenor, observationDate: fields[8], value,
          unit: "PERCENT_PER_ANNUM", curveType: "ZERO_COUPON_SPOT_SVENSSON", source: "ECB_YIELD_CURVE_YC",
          sourceUrl: url, fetchedAt, publicationDate: null, revisionStatus: "CURRENT_ECB_DATA_PORTAL_VALUE",
          parserVersion: PARSER_VERSION, qualityStatus: "PASS" }];
      });
      if (!rows.length) throw new Error("PARSE_FAILURE:NO_OBSERVATIONS");
      await writeFile(path.join(ROOT, "raw", `${tenor}.csv`), csv, "utf8");
      await writeFile(normalizedPath, `${JSON.stringify({ country: "EA", tenor, key: `YC.${key}`, sourceUrl: url, fetchedAt, sourceSha256: sha256(csv), parserVersion: PARSER_VERSION, rows }, null, 2)}\n`, "utf8");
      totalRows += rows.length; completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendFile(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), country: "EA", tenor, reasonCode: message.split(":")[0], message, retryable: /TIMEOUT|ACCESS|aborted/i.test(message) })}\n`, "utf8");
    }
    await writeFile(CHECKPOINT, `${JSON.stringify({ asset: "GOVERNMENT_YIELD", layer: "L4_OFFICIAL_HISTORICAL", country: "EA", tenor, completed, totalRows, updatedAt: new Date().toISOString(), continuing: true }, null, 2)}\n`, "utf8");
  }
  const status = completed === TENORS.length ? "COMPLETED" : "COMPLETED_WITH_GAPS";
  await writeFile(CHECKPOINT, `${JSON.stringify({ asset: "GOVERNMENT_YIELD", layer: "L4_OFFICIAL_HISTORICAL", country: "EA", status, completed, totalRows, updatedAt: new Date().toISOString(), next: "GB", continuing: true }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status, country: "EA", completed, totalRows, next: "GB" }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
