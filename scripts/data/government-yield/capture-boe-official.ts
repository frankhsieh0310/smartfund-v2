import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield")), "bank-of-england");
const BASE = "https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves";
const SOURCES = [
  { kind: "nominal", file: "glcnominalddata.zip" },
  { kind: "real", file: "glcrealddata.zip" },
  { kind: "inflation", file: "glcinflationddata.zip" }
];

async function main(): Promise<void> {
  await mkdir(path.join(ROOT, "raw"), { recursive: true });
  const captures = [];
  for (const source of SOURCES) {
    const url = `${BASE}/${source.file}`;
    try {
      const fetchedAt = new Date().toISOString();
      const response = await fetch(url, { headers: { Accept: "application/zip", "User-Agent": "SmartFund Government Yield/1.0" }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`BLOCKED_SOURCE_ACCESS:${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(path.join(ROOT, "raw", source.file), bytes);
      captures.push({ ...source, url, fetchedAt, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), status: "ARCHIVED" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendFile(path.join(ROOT, "failures.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), country: "GB", kind: source.kind, reasonCode: message.split(":")[0], message, retryable: true })}\n`, "utf8");
    }
  }
  const status = captures.length === SOURCES.length ? "ARCHIVE_COMPLETED_PARSE_PENDING" : "COMPLETED_WITH_GAPS";
  await writeFile(path.join(ROOT, "source-manifest.json"), `${JSON.stringify({ country: "GB", sourcePage: "https://www.bankofengland.co.uk/statistics/yield-curves", captures }, null, 2)}\n`, "utf8");
  await writeFile(path.join(ROOT, "checkpoint.json"), `${JSON.stringify({ asset: "GOVERNMENT_YIELD", layer: "L4_OFFICIAL_HISTORICAL", country: "GB", status, captures: captures.length, updatedAt: new Date().toISOString(), reasonCode: "PARSE_FAILURE", next: "OTHER_REGISTRY_COUNTRIES", continuing: true }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status, country: "GB", captures: captures.length, bytes: captures.reduce((sum, item) => sum + item.bytes, 0), next: "OTHER_REGISTRY_COUNTRIES" }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
