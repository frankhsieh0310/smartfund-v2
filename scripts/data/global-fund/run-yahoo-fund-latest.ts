import { PrismaClient } from "@prisma/client";
import { fetchYahooFundHoldings, fetchYahooFundProfile } from "./adapters/yahoo-fund.ts";

const prisma = new PrismaClient();
const canaryArg = process.argv.find((argument) => argument.startsWith("--canary="));
const limit = canaryArg ? Number(canaryArg.split("=")[1]) : 10;
const source = "YAHOO_TW_FUND";

function classify(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP_429|rate.?limit/i.test(message)) return "RATE_LIMITED";
  if (/HTTP_/.test(message)) return "HTTP_ERROR";
  if (/NO_DATA/.test(message)) return "NO_DATA";
  if (/INVALID_SOURCE_DATE/.test(message)) return "INVALID_SOURCE_DATE";
  if (/INVALID_YAHOO_FUND_ID/.test(message)) return "INVALID_IDENTITY";
  return "FETCH_OR_WRITE_FAILED";
}

async function main() {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("INVALID_BATCH_LIMIT");
  const mappings = await prisma.fundProviderMapping.findMany({
    where: { provider: "yahoo" }, orderBy: { id: "asc" }, take: limit,
    select: { fundId: true, providerCode: true },
  });

  let success = 0;
  let categoryUpdated = 0;
  const failures: Array<{ fundId: string; providerCode: string; reason: string }> = [];
  const categoryFailures: Array<{ fundId: string; providerCode: string; reason: string }> = [];
  for (const mapping of mappings) {
    // Fund "group"/category metadata sync — independent of the holdings fetch/transaction below,
    // so a holdings-parse failure (or a fund with no holdings disclosure) never blocks the
    // category from staying in sync. Yahoo's own text, saved verbatim; NOOP when unchanged.
    try {
      const profile = await fetchYahooFundProfile(mapping.providerCode);
      if (profile.categoryName) {
        const updated = await prisma.$executeRawUnsafe(
          `UPDATE funds SET category=$2, updated_at=NOW() WHERE id=$1 AND category IS DISTINCT FROM $2`,
          mapping.fundId, profile.categoryName,
        );
        if (updated > 0) categoryUpdated++;
      }
    } catch (error) {
      categoryFailures.push({
        fundId: mapping.fundId, providerCode: mapping.providerCode,
        reason: `${classify(error)}:${error instanceof Error ? error.message : String(error)}`,
      });
    }
    try {
      const observation = await fetchYahooFundHoldings(mapping.providerCode);
      const filingId = `yahoo:${observation.providerId.toLowerCase()}:${observation.asOfDate}`;
      await prisma.$transaction(async (db) => {
        for (const holding of observation.holdings) {
          const identity = holding.symbol ?? holding.name;
          const sourceRecordId = `${observation.asOfDate}:${holding.rank}:${identity}`.slice(0, 500);
          await db.$executeRawUnsafe(
            `INSERT INTO holdings
              (id,asset_type,fund_id,share_class_id,as_of_date,rank,holding_name,weight,source,source_record_id,filing_id,weight_method,created_at)
             VALUES ($1,'FUND',$2,NULL,$3::date,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
             ON CONFLICT(fund_id,source,filing_id,source_record_id)
             WHERE fund_id IS NOT NULL AND source IS NOT NULL AND filing_id IS NOT NULL AND source_record_id IS NOT NULL
             DO UPDATE SET as_of_date=EXCLUDED.as_of_date,rank=EXCLUDED.rank,holding_name=EXCLUDED.holding_name,
               weight=EXCLUDED.weight,weight_method=EXCLUDED.weight_method`,
            crypto.randomUUID(), mapping.fundId, observation.asOfDate, holding.rank, holding.name,
            holding.weight, source, sourceRecordId, filingId, "TOP_HOLDINGS_DISCLOSED",
          );
        }
      }, { maxWait: 10_000, timeout: 30_000 });
      success++;
    } catch (error) {
      failures.push({
        fundId: mapping.fundId, providerCode: mapping.providerCode,
        reason: `${classify(error)}:${error instanceof Error ? error.message : String(error)}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(JSON.stringify({ target: limit, attempted: mappings.length, success, failed: failures.length, failures, categoryUpdated, categoryFailed: categoryFailures.length, categoryFailures }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
