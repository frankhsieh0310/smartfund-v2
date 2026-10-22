import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.ts";
import { importTpexDocument } from "../../../lib/data-platform/industry-chain/repository.ts";
import { TPEX_INDUSTRY_CHAIN_SOURCE, TpexIndustryChainAdapter } from "../../../lib/data-platform/industry-chain/tpex.ts";

const apply = process.argv.includes("--apply");
const industryArgument = process.argv.find((argument) => argument.startsWith("--industry"));
if (industryArgument && !industryArgument.startsWith("--industry=")) {
  throw new Error("Invalid industry selector. Expected --industry=<official industry code>.");
}
const selectedIndustryCode = industryArgument?.slice("--industry=".length).trim().toUpperCase() || null;
if (industryArgument && !selectedIndustryCode) {
  throw new Error("Industry selector cannot be empty.");
}
const adapter = new TpexIndustryChainAdapter();
const discoveredIndustries = await adapter.discover();
const industries = selectedIndustryCode
  ? discoveredIndustries.filter((industry) => industry.sourceId.toUpperCase() === selectedIndustryCode)
  : discoveredIndustries;
if (selectedIndustryCode && industries.length !== 1) {
  throw new Error(`Official TPEx industry not found: ${selectedIndustryCode}`);
}
if (!apply) {
  console.log(JSON.stringify({ mode: "DRY_RUN", industries: industries.length, source: TPEX_INDUSTRY_CHAIN_SOURCE }));
  await prisma.$disconnect();
} else {
const checkpointRows = await prisma.$queryRaw<Array<{ completedIds: unknown }>>(Prisma.sql`SELECT completed_ids AS "completedIds" FROM industry_chain_import_checkpoints WHERE source=${TPEX_INDUSTRY_CHAIN_SOURCE}`);
const completed = new Set(Array.isArray(checkpointRows[0]?.completedIds) ? checkpointRows[0].completedIds as string[] : []);
const failed: Array<{ industryId: string; error: string }> = [];
await prisma.$executeRaw(Prisma.sql`INSERT INTO industry_chain_import_checkpoints (source, discovered_ids, completed_ids, status, attempts, started_at, updated_at) VALUES (${TPEX_INDUSTRY_CHAIN_SOURCE}, ${JSON.stringify(industries.map(i=>i.sourceId))}::jsonb, ${JSON.stringify([...completed])}::jsonb, 'RUNNING', 1, NOW(), NOW()) ON CONFLICT (source) DO UPDATE SET discovered_ids=EXCLUDED.discovered_ids, status='RUNNING', attempts=industry_chain_import_checkpoints.attempts+1, last_error=NULL, updated_at=NOW()`);
for (const industry of industries) {
  if (completed.has(industry.sourceId)) continue;
  let imported = false;
  for (let attempt = 1; attempt <= 3 && !imported; attempt += 1) {
    try {
      await prisma.$executeRaw(Prisma.sql`UPDATE industry_chain_import_checkpoints SET current_industry_id=${industry.sourceId}, status='RUNNING', updated_at=NOW() WHERE source=${TPEX_INDUSTRY_CHAIN_SOURCE}`);
      await importTpexDocument(await adapter.fetchIndustry(industry));
      completed.add(industry.sourceId);
      imported = true;
      await prisma.$executeRaw(Prisma.sql`UPDATE industry_chain_import_checkpoints SET completed_ids=${JSON.stringify([...completed])}::jsonb, last_error=NULL, updated_at=NOW() WHERE source=${TPEX_INDUSTRY_CHAIN_SOURCE}`);
      await adapter.wait();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.$executeRaw(Prisma.sql`UPDATE industry_chain_import_checkpoints SET status='RETRY_WAIT', last_error=${message}, updated_at=NOW() WHERE source=${TPEX_INDUSTRY_CHAIN_SOURCE}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      else failed.push({ industryId: industry.sourceId, error: message });
    }
  }
}
await prisma.$executeRaw(Prisma.sql`UPDATE industry_chain_import_checkpoints SET status=${failed.length ? "PARTIAL" : "COMPLETE"}, current_industry_id=NULL, completed_at=CASE WHEN ${failed.length}=0 THEN NOW() ELSE NULL END, last_error=${failed.length ? JSON.stringify(failed) : null}, updated_at=NOW() WHERE source=${TPEX_INDUSTRY_CHAIN_SOURCE}`);
await prisma.$disconnect();
}
