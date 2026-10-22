import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "fixed-income", "public-bond-index-pages-v18");
const now = () => new Date().toISOString();

async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

function dbUrl() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pgbouncer", "true");
  return url.toString();
}

const sources = [
  {
    id: "source-route:moneydj-bond-index-pages",
    provider: "MoneyDJ",
    status: "AUTOMATED_EXTRACTION_PROHIBITED",
    evidence: "MoneyDJ terms section 5 prohibits automated devices, scripts, spiders, crawlers, and extraction programs without consent.",
    sourceUrl: "https://www.moneydj.com/z/ABMoneydj/aboutTermsService.djhtm",
  },
  {
    id: "source-route:stockq-bond-index-pages",
    provider: "StockQ",
    status: "THIRD_PARTY_COMMERCIAL_BENCHMARK_DISPLAY_NO_STORAGE_GRANT",
    evidence: "Pages display ICE, Bloomberg/BC and J.P. Morgan benchmark values; no exact storage/redistribution grant was found.",
    sourceUrl: "https://www.stockq.org/bond/",
  },
  {
    id: "source-route:cnyes-bond-index-pages",
    provider: "CNYES",
    status: "WRITTEN_AUTHORIZATION_REQUIRED",
    evidence: "CNYES copyright notice prohibits use, reproduction, distribution, publication or transmission without written authorization.",
    sourceUrl: "https://www.cnyes.com/announce.htm",
  },
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  const startedAt = now();
  await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, startedAt, maxDbConcurrency: 1 });
  try {
    let coverageMetadataWritten = 0;
    for (const source of sources) {
      coverageMetadataWritten += await prisma.$executeRawUnsafe(
        `INSERT INTO global_index_coverage(index_id,capability,interval,status,provider,licensing_status,row_count,quality_status,details,checked_at)
         VALUES($1,'PUBLIC_BOND_INDEX_PAGE_V18','',$2,$3,$2,0,'RIGHTS_VERIFIED',$4::jsonb,NOW())
         ON CONFLICT(index_id,capability,interval) DO UPDATE SET status=EXCLUDED.status,provider=EXCLUDED.provider,
         licensing_status=EXCLUDED.licensing_status,row_count=0,quality_status='RIGHTS_VERIFIED',details=EXCLUDED.details,checked_at=NOW()`,
        source.id,
        source.status,
        source.provider,
        JSON.stringify({ ...source, publicPageFound: source.provider === "StockQ", storageAllowed: false, observationsWritten: 0, etfProxy: false, fundProxy: false, synthetic: false }),
      );
    }
    const readback = await prisma.$queryRawUnsafe<Array<{ index_id: string }>>(
      `SELECT index_id FROM global_index_coverage WHERE capability='PUBLIC_BOND_INDEX_PAGE_V18' ORDER BY index_id`,
    );
    const report = {
      status: "COMPLETE_NO_AUTHORIZED_STORAGE_ROUTE",
      sourcesFound: 1,
      indexesFound: 20,
      indexLevelRows: 0,
      returnRows: 0,
      yieldRows: 0,
      spreadRows: 0,
      durationRows: 0,
      historyRows: 0,
      databaseRowsAdded: 0,
      coverageMetadataWritten,
      coverageReadback: readback.length,
      autoContinuing: false,
      blocker: "NO_SOURCE_GRANTS_PROGRAMMATIC_DATABASE_STORAGE; COMMERCIAL_BENCHMARK_RIGHTS_PRESERVED",
      updatedAt: now(),
    };
    await atomic(path.join(ROOT, "report.json"), report);
    await atomic(path.join(ROOT, "checkpoint.json"), { state: "BLOCKED", pid: null, checkpoint: "3/3 SOURCE ROUTES RIGHTS-VERIFIED; 0 STORAGE-ALLOWED", ...report, maxDbConcurrency: 1 });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
