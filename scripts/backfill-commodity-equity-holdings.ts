// 2026-10-18 修正一: populate real iShares holdings (with Sector) for the 4 commodity-theme equity
// ETFs added to config/ishares-commodity-equity-etf-products.json (RING/SLVP/ICOP/PICK). Reuses the
// existing, already-approved fetchIsharesHoldings/persistIsharesHoldings pipeline verbatim -- this
// is a data backfill for a newly-widened universe, not new write logic.
// Dry run by default; --write actually persists. Scoped to exactly these 4 ETF ids.
import { prisma } from "@/lib/prisma";
import { fetchIsharesHoldings, persistIsharesHoldings } from "@/lib/cloud-ingestion/globalEtfHoldings";
import registry from "../config/ishares-commodity-equity-etf-products.json";

async function main() {
  const writeEnabled = process.argv.includes("--write");
  const before = await prisma.$queryRawUnsafe<Array<{ code: string; c: number }>>(
    `SELECT e.code, count(h.id)::int AS c FROM etfs e LEFT JOIN holdings h ON h.etf_id::text = e.id::text AND h.asset_type='ETF'
     WHERE e.id::text = ANY($1::text[]) GROUP BY e.code ORDER BY e.code`,
    registry.products.map((p) => p.etfId),
  );
  console.log("BEFORE:", before);

  for (const p of registry.products) {
    try {
      const data = await fetchIsharesHoldings({ code: p.code, sourceUrl: p.sourceUrl });
      console.log(`${p.code}: fetched ${data.rows.length} rows, asOf=${data.asOfIso}, sample sector=${data.rows[0]?.sector}`);
      if (writeEnabled) {
        const res = await persistIsharesHoldings(prisma, { etfId: p.etfId, assetId: null, data });
        console.log(`${p.code}: WROTE ${res.written} rows (${res.matched} matched to securities)`);
      }
    } catch (e) {
      console.error(`${p.code}: FAILED`, e);
    }
  }

  if (writeEnabled) {
    const after = await prisma.$queryRawUnsafe<Array<{ code: string; c: number }>>(
      `SELECT e.code, count(h.id)::int AS c FROM etfs e LEFT JOIN holdings h ON h.etf_id::text = e.id::text AND h.asset_type='ETF'
       WHERE e.id::text = ANY($1::text[]) GROUP BY e.code ORDER BY e.code`,
      registry.products.map((p) => p.etfId),
    );
    console.log("AFTER:", after);
  }
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
