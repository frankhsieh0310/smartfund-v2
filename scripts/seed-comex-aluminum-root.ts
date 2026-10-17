// Item 6 of the weekend task list (商品覆蓋): adds the missing COMEX aluminum root.
// futures_product_roots already has an aluminum row, but it's the LME-listed contract
// (root_symbol "AH", exchange "LME") — Yahoo's ALI=F is a DIFFERENT, COMEX-settled contract
// (confirmed live: chart meta exchangeName "CMX", instrumentType "FUTURE", real recent daily
// closes e.g. 2026-10-16: 3113.25 USD). Writing ALI=F onto the LME root would mislabel the
// source, so this creates a SEPARATE root for it, reusing the existing generic "Aluminum"
// commodity_identities row (264b4b92-58e4-4225-a91b-49ae30a9260d) since it's the same
// underlying commodity, just a different exchange-listed contract.
//
// Standing rule: no DB write without explicit user approval. This script defaults to a
// dry run (prints what it would insert) and only writes when run with --write.
//   npx tsx scripts/seed-comex-aluminum-root.ts          (dry run, no DB write)
//   npx tsx scripts/seed-comex-aluminum-root.ts --write  (actually inserts the row)

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

const ALUMINUM_COMMODITY_ID = "264b4b92-58e4-4225-a91b-49ae30a9260d";

async function main() {
  const writeEnabled = process.argv.includes("--write");

  const existing = await prisma.$queryRawUnsafe<Array<{ id: string; root_symbol: string; exchange: string }>>(
    `SELECT id::text, root_symbol, exchange FROM futures_product_roots WHERE root_symbol = 'ALI' AND exchange = 'COMEX'`,
  );
  if (existing.length) {
    console.log("Already exists, nothing to do:", existing[0]);
    return;
  }

  const newId = randomUUID();
  const row = {
    id: newId,
    commodity_id: ALUMINUM_COMMODITY_ID,
    asset_class: "COMMODITY_FUTURES",
    official_product_name: "Aluminum Futures (COMEX)",
    root_symbol: "ALI",
    exchange: "COMEX",
    currency: "USD",
    status: "ACTIVE",
    source: "Yahoo Finance chart API (symbol ALI=F, chart meta exchangeName \"CMX\")",
    verification_status: "PENDING",
    license_status: "LICENSE_PENDING",
    product_state: "LICENSE_CONSTRAINED",
    missing_reason: "OFFICIAL_DATA_LICENSE_REQUIRED",
  };

  console.log(writeEnabled ? "WRITING row:" : "DRY RUN — would insert this row (pass --write to actually insert):", row);
  if (!writeEnabled) return;

  await prisma.$executeRawUnsafe(
    `INSERT INTO futures_product_roots
       (id, commodity_id, asset_class, official_product_name, root_symbol, exchange, currency, status,
        source, verification_status, license_status, product_state, missing_reason)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    row.id, row.commodity_id, row.asset_class, row.official_product_name, row.root_symbol, row.exchange,
    row.currency, row.status, row.source, row.verification_status, row.license_status, row.product_state, row.missing_reason,
  );
  console.log("Inserted. New root id:", newId, "— next step: add it to CORE_COMMODITY_ROOTS in lib/cron/commodityUpdate.ts");
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
