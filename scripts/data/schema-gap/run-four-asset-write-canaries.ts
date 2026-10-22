import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

async function securityCanaries() {
  const securities = await prisma.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM securities ORDER BY created_at LIMIT 1");
  if (!securities[0]) throw new Error("NO_CANONICAL_SECURITY_FOR_CANARY");
  const securityId = securities[0].id;
  return prisma.$transaction(async tx => {
    const institutionalKey = `SCHEMA_CANARY:INSTITUTIONAL:${securityId}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO institutional_holdings (institution_id,institution_name,security_id,report_date,shares,value,source,filing_id,source_key)
       VALUES ('SCHEMA_CANARY','Schema Canary',$1,CURRENT_DATE,1,NULL,'SCHEMA_CANARY','SCHEMA_CANARY',$2)
       ON CONFLICT (source_key) DO UPDATE SET updated_at=NOW()`, securityId, institutionalKey,
    );
    const institutional = await tx.$queryRawUnsafe<Array<{ source_key: string }>>("SELECT source_key FROM institutional_holdings WHERE source_key=$1", institutionalKey);

    const insiderKey = `SCHEMA_CANARY:INSIDER:${securityId}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO insider_ownership_transactions (security_id,insider,role,transaction_date,transaction_type,shares,price,ownership_after,source,filing_id,source_key)
       VALUES ($1,'Schema Canary',NULL,CURRENT_DATE,'SCHEMA_CANARY',1,NULL,NULL,'SCHEMA_CANARY','SCHEMA_CANARY',$2)
       ON CONFLICT (source_key) DO UPDATE SET updated_at=NOW()`, securityId, insiderKey,
    );
    const insider = await tx.$queryRawUnsafe<Array<{ source_key: string }>>("SELECT source_key FROM insider_ownership_transactions WHERE source_key=$1", insiderKey);
    await tx.$executeRawUnsafe("DELETE FROM institutional_holdings WHERE source_key=$1", institutionalKey);
    await tx.$executeRawUnsafe("DELETE FROM insider_ownership_transactions WHERE source_key=$1", insiderKey);
    return { institutional: institutional.length === 1, insider: insider.length === 1 };
  });
}

async function cryptoCanary() {
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_networks (id,name,native_asset_id,chain_id,genesis_at,official_url,explorer_url,source_url)
    VALUES ('bitcoin','Bitcoin','btc',NULL,'2009-01-03','https://bitcoin.org/','https://mempool.space/','https://bitcoin.org/')
    ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`);
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_networks (id,name,native_asset_id,chain_id,genesis_at,official_url,explorer_url,source_url)
    VALUES ('ethereum','Ethereum','eth','1','2015-07-30','https://ethereum.org/','https://etherscan.io/','https://ethereum.org/')
    ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`);
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_assets (id,name,symbol,network_id,decimals,genesis_at,stablecoin,official_url,source_url)
    VALUES ('btc','Bitcoin','BTC','bitcoin',8,'2009-01-03',FALSE,'https://bitcoin.org/','https://bitcoin.org/') ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`);
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_assets (id,name,symbol,network_id,contract_address,decimals,genesis_at,stablecoin,official_url,source_url)
    VALUES ('usdt','Tether USD','USDT','ethereum','0xdAC17F958D2ee523a2206206994597C13D831ec7',6,'2015-07-30',TRUE,'https://ethereum.org/','https://ethereum.org/') ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`);
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_exchanges (id,name,official_url,api_url,spot,derivatives,source_url)
    VALUES ('binance','Binance','https://www.binance.com/','https://api.binance.com',TRUE,TRUE,'https://www.binance.com/') ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`);
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_markets (id,exchange_id,base_asset_id,quote_asset_id,provider_symbol,market_type)
    VALUES ('binance-btc-usdt-spot','binance','btc','usdt','BTCUSDT','SPOT') ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM crypto_assets WHERE id='btc'");
  return rows.length === 1;
}

async function electricityCanary() {
  const root = path.join(process.cwd(), "runtime", "electricity-markets", "archive", "gb-elexon");
  const dates = (await fs.readdir(root)).sort().reverse();
  let sourceFile = "";
  for (const date of dates) {
    const files = (await fs.readdir(path.join(root, date))).filter(name => name.endsWith(".json") && !name.endsWith("metadata.json")).sort().reverse();
    if (files[0]) { sourceFile = path.join(root, date, files[0]); break; }
  }
  if (!sourceFile) throw new Error("NO_ELEXON_CANARY_PAYLOAD");
  const payload = JSON.parse(await fs.readFile(sourceFile, "utf8"));
  const row = payload?.data?.find((item: any) => Number.isFinite(item?.price));
  if (!row) throw new Error("NO_ELEXON_PRICE_OBSERVATION");
  const sourceKey = createHash("sha256").update(`ELEXON|${row.dataProvider}|${row.startTime}|PRICE`).digest("hex");
  await prisma.$executeRawUnsafe(
    `INSERT INTO electricity_observations (market,region,node,observed_at,timezone,metric_type,value,unit,source,source_key)
     VALUES ('GB','Great Britain',$1,$2,'Europe/London','PRICE',$3::decimal,'GBP/MWh','ELEXON_BMRS',$4)
     ON CONFLICT (source_key) DO NOTHING`, row.dataProvider ?? null, new Date(row.startTime), String(row.price), sourceKey,
  );
  const rows = await prisma.$queryRawUnsafe<Array<{ source_key: string }>>("SELECT source_key FROM electricity_observations WHERE source_key=$1", sourceKey);
  return rows.length === 1;
}

const identities = await securityCanaries();
const crypto = await cryptoCanary();
const electricity = await electricityCanary();
console.log(JSON.stringify({ institutional: identities.institutional, insider: identities.insider, crypto, electricity }));
await prisma.$disconnect();
