import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const checkpointPath = path.resolve("runtime/stock-ownership-canonical-remap/checkpoint.json");

type Counts = Record<string, number | string | null>;
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? Number(item) : item, 2);

async function checkpoint(value: unknown) {
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${json(value)}\n`, "utf8");
  await rename(temporary, checkpointPath);
}

async function summary() {
  const [totals, types, mapped, histories, reverse, quality, identifiers, sources, resolution] = await Promise.all([
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT
        (SELECT count(*) FROM holdings WHERE etf_id IS NOT NULL)::int etf_rows,
        (SELECT count(*) FROM holdings WHERE etf_id IS NOT NULL AND security_id IS NOT NULL)::int etf_security_rows,
        ((SELECT count(*) FROM fund_holdings)+(SELECT count(*) FROM holdings WHERE fund_id IS NOT NULL))::int fund_rows,
        ((SELECT count(*) FROM fund_holdings WHERE security_id IS NOT NULL)+(SELECT count(*) FROM holdings WHERE fund_id IS NOT NULL AND security_id IS NOT NULL))::int fund_security_rows,
        (SELECT count(*) FROM institutional_holdings)::int institutional_rows,
        (SELECT count(*) FROM institutional_holdings WHERE security_id IS NOT NULL)::int institutional_security_rows
    `),
    prisma.$queryRawUnsafe<Counts[]>(`SELECT asset_type::text AS holding_owner_type, count(*)::int rows FROM holdings GROUP BY asset_type ORDER BY asset_type`),
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT
        (SELECT count(*) FROM holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE h.etf_id IS NOT NULL)::int etf_stock_rows,
        (SELECT count(DISTINCT h.etf_id) FROM holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE h.etf_id IS NOT NULL)::int etfs,
        (SELECT count(DISTINCT l.stock_id) FROM holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE h.etf_id IS NOT NULL)::int etf_stocks,
        ((SELECT count(*) FROM fund_holdings h JOIN stock_security_links l ON l.security_id=h.security_id)+(SELECT count(*) FROM holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE h.fund_id IS NOT NULL))::int fund_stock_rows,
        (SELECT count(DISTINCT fund_id) FROM (SELECT h.fund_id FROM fund_holdings h JOIN stock_security_links l ON l.security_id=h.security_id UNION ALL SELECT h.fund_id FROM holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE h.fund_id IS NOT NULL) f)::int funds,
        (SELECT count(DISTINCT stock_id) FROM (SELECT l.stock_id FROM fund_holdings h JOIN stock_security_links l ON l.security_id=h.security_id UNION ALL SELECT l.stock_id FROM holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE h.fund_id IS NOT NULL) f)::int fund_stocks,
        (SELECT count(*) FROM institutional_holdings h JOIN stock_security_links l ON l.security_id=h.security_id)::int institutional_stock_rows,
        (SELECT count(DISTINCT h.institution_id) FROM institutional_holdings h JOIN stock_security_links l ON l.security_id=h.security_id)::int institutions,
        (SELECT count(DISTINCT l.stock_id) FROM institutional_holdings h JOIN stock_security_links l ON l.security_id=h.security_id)::int institutional_stocks
    `),
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT
        (SELECT count(*) FROM (SELECT etf_id,security_id FROM holdings WHERE etf_id IS NOT NULL AND security_id IS NOT NULL GROUP BY etf_id,security_id HAVING count(DISTINCT as_of_date)>1) x)::int etf_multi_snapshot,
        ((SELECT count(*) FROM (SELECT fund_id,security_id FROM fund_holdings WHERE security_id IS NOT NULL GROUP BY fund_id,security_id HAVING count(DISTINCT report_date)>1) x)+(SELECT count(*) FROM (SELECT fund_id,security_id FROM holdings WHERE fund_id IS NOT NULL AND security_id IS NOT NULL GROUP BY fund_id,security_id HAVING count(DISTINCT as_of_date)>1) y))::int fund_multi_snapshot,
        (SELECT count(*) FROM (SELECT institution_id,security_id FROM institutional_holdings GROUP BY institution_id,security_id HAVING count(DISTINCT report_date)>1) x)::int institutional_multi_snapshot
    `),
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT s.ticker,s.exchange,
        (SELECT count(DISTINCT h.etf_id) FROM holdings h WHERE h.security_id=l.security_id AND h.etf_id IS NOT NULL)::int etf_count,
        ((SELECT count(DISTINCT h.fund_id) FROM fund_holdings h WHERE h.security_id=l.security_id)+(SELECT count(DISTINCT h.fund_id) FROM holdings h WHERE h.security_id=l.security_id AND h.fund_id IS NOT NULL))::int fund_count,
        (SELECT count(DISTINCT h.institution_id) FROM institutional_holdings h WHERE h.security_id=l.security_id)::int institution_count
      FROM stocks s JOIN stock_security_links l ON l.stock_id=s.id
      WHERE (s.ticker,s.exchange) IN (('2330','TWSE'),('2303','TWSE'),('2454','TWSE'),('AAPL','NASDAQ'),('MSFT','NASDAQ'),('NVDA','NASDAQ'))
      GROUP BY s.ticker,s.exchange,l.security_id ORDER BY s.ticker
    `),
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT
        (SELECT count(*) FROM holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE h.etf_id IS NOT NULL AND h.security_id IS NOT NULL AND s.id IS NULL)::int etf_orphans,
        ((SELECT count(*) FROM fund_holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE h.security_id IS NOT NULL AND s.id IS NULL)+(SELECT count(*) FROM holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE h.fund_id IS NOT NULL AND h.security_id IS NOT NULL AND s.id IS NULL))::int fund_orphans,
        (SELECT count(*) FROM institutional_holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE s.id IS NULL)::int institutional_orphans
    `),
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT
        count(*) FILTER (WHERE etf_id IS NOT NULL AND isin IS NOT NULL)::int etf_isin,
        count(*) FILTER (WHERE etf_id IS NOT NULL AND cusip IS NOT NULL)::int etf_cusip,
        count(*) FILTER (WHERE etf_id IS NOT NULL AND ticker IS NOT NULL)::int etf_ticker,
        count(*) FILTER (WHERE etf_id IS NOT NULL AND holding_code IS NOT NULL)::int etf_holding_code,
        count(*) FILTER (WHERE etf_id IS NOT NULL AND source IS NOT NULL)::int etf_source,
        count(*) FILTER (WHERE fund_id IS NOT NULL AND isin IS NOT NULL)::int legacy_fund_isin,
        count(*) FILTER (WHERE fund_id IS NOT NULL AND cusip IS NOT NULL)::int legacy_fund_cusip,
        count(*) FILTER (WHERE fund_id IS NOT NULL AND holding_code IS NOT NULL)::int legacy_fund_holding_code
      FROM holdings
    `),
    prisma.$queryRawUnsafe<Counts[]>(`
      SELECT coalesce(source,'NULL') AS source, count(*)::int rows,
             count(*) FILTER (WHERE holding_code IS NOT NULL)::int holding_code_rows,
             count(*) FILTER (WHERE ticker IS NOT NULL)::int ticker_rows,
             count(*) FILTER (WHERE isin IS NOT NULL)::int isin_rows,
             count(*) FILTER (WHERE cusip IS NOT NULL)::int cusip_rows
      FROM holdings GROUP BY source ORDER BY rows DESC
    `),
    prisma.$queryRawUnsafe<Counts[]>(`
      WITH all_rows AS (
        SELECT 'ETF' kind,id::text,isin,cusip,NULL::text sedol,ticker,holding_code FROM holdings WHERE etf_id IS NOT NULL
        UNION ALL SELECT 'FUND',id::text,isin,cusip,NULL::text,NULL,NULL FROM fund_holdings
        UNION ALL SELECT 'FUND',id::text,isin,cusip,NULL::text,ticker,holding_code FROM holdings WHERE fund_id IS NOT NULL
        UNION ALL SELECT 'INSTITUTIONAL',id::text,isin,cusip,sedol,NULL,NULL FROM institutional_holdings
      ), matches AS (
        SELECT r.kind,r.id,s.id security_id FROM all_rows r JOIN securities s ON s.isin=r.isin WHERE r.isin IS NOT NULL
        UNION ALL SELECT r.kind,r.id,s.id FROM all_rows r JOIN securities s ON s.cusip=r.cusip WHERE r.cusip IS NOT NULL
        UNION ALL SELECT r.kind,r.id,s.id FROM all_rows r JOIN securities s ON s.sedol=r.sedol WHERE r.sedol IS NOT NULL
      ), classified AS (
        SELECT r.kind,r.id,r.isin,r.cusip,r.sedol,r.ticker,r.holding_code,
               count(DISTINCT m.security_id)::int candidates,
               count(DISTINCT l.security_id)::int stock_candidates
        FROM all_rows r LEFT JOIN matches m ON m.kind=r.kind AND m.id=r.id
        LEFT JOIN stock_security_links l ON l.security_id=m.security_id
        GROUP BY r.kind,r.id,r.isin,r.cusip,r.sedol,r.ticker,r.holding_code
      )
      SELECT kind,count(*)::int rows,
        count(*) FILTER (WHERE isin IS NULL AND cusip IS NULL AND sedol IS NULL AND ticker IS NULL AND holding_code IS NULL)::int identifier_missing,
        count(*) FILTER (WHERE isin IS NULL AND cusip IS NULL AND sedol IS NULL AND (ticker IS NOT NULL OR holding_code IS NOT NULL))::int exchange_missing,
        count(*) FILTER (WHERE (isin IS NOT NULL OR cusip IS NOT NULL OR sedol IS NOT NULL) AND candidates=0)::int identifier_not_in_master,
        count(*) FILTER (WHERE candidates>1)::int ambiguous_identifier,
        count(*) FILTER (WHERE candidates=1 AND stock_candidates=0)::int mapped_non_stock,
        count(*) FILTER (WHERE stock_candidates=1)::int stock_resolvable
      FROM classified GROUP BY kind ORDER BY kind
    `),
  ]);
  return { totals: totals[0], holdingTypes: types, mapped: mapped[0], histories: histories[0], reverse, quality: quality[0], identifiers: identifiers[0], sources, resolution };
}

async function remap(db: Pick<PrismaClient, "$executeRawUnsafe">, table: "holdings" | "fund_holdings") {
  const equityGate = table === "holdings" ? `AND (h.etf_id IS NOT NULL OR h.fund_id IS NOT NULL)` : "";
  const update = table === "fund_holdings" ? "security_id=c.security_id, updated_at=CURRENT_TIMESTAMP" : "security_id=c.security_id";
  return db.$executeRawUnsafe(`
    WITH matches AS (
      SELECT h.id AS holding_id,s.id AS security_id FROM ${table} h JOIN securities s ON s.isin=h.isin
      WHERE h.security_id IS NULL AND h.isin IS NOT NULL ${equityGate}
      UNION ALL
      SELECT h.id,s.id FROM ${table} h JOIN securities s ON s.cusip=h.cusip
      WHERE h.security_id IS NULL AND h.cusip IS NOT NULL ${equityGate}
    ), candidates AS (
      SELECT m.holding_id AS id,min(m.security_id) AS security_id
      FROM matches m JOIN stock_security_links l ON l.security_id=m.security_id
      GROUP BY m.holding_id HAVING count(DISTINCT m.security_id)=1
    )
    UPDATE ${table} h SET ${update}
    FROM candidates c WHERE h.id=c.id AND h.security_id IS NULL
  `);
}

async function remapInstitutional(db: Pick<PrismaClient, "$executeRawUnsafe">) {
  return db.$executeRawUnsafe(`
    WITH orphan AS (
      SELECT h.* FROM institutional_holdings h LEFT JOIN securities current_security ON current_security.id=h.security_id
      WHERE current_security.id IS NULL
    ), matches AS (
      SELECT h.id AS holding_id,s.id AS security_id FROM orphan h JOIN securities s ON s.isin=h.isin WHERE h.isin IS NOT NULL
      UNION ALL
      SELECT h.id,s.id FROM orphan h JOIN securities s ON s.cusip=h.cusip WHERE h.cusip IS NOT NULL
      UNION ALL
      SELECT h.id,s.id FROM orphan h JOIN securities s ON s.sedol=h.sedol WHERE h.sedol IS NOT NULL
    ), candidates AS (
      SELECT m.holding_id AS id,min(m.security_id) AS security_id
      FROM matches m JOIN stock_security_links l ON l.security_id=m.security_id
      GROUP BY m.holding_id HAVING count(DISTINCT m.security_id)=1
    )
    UPDATE institutional_holdings h
    SET security_id=c.security_id, updated_at=CURRENT_TIMESTAMP
    FROM candidates c WHERE h.id=c.id
  `);
}

async function main() {
  const metadata = await prisma.$queryRawUnsafe<Counts[]>(`
    SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema='public' AND (table_name ILIKE '%holding%' OR table_name='holdings')
    GROUP BY table_name ORDER BY table_name
  `);
  const available = new Set(metadata.map(row => String(row.table_name)));
  if (!["holdings", "fund_holdings", "institutional_holdings"].every(table => available.has(table))) {
    console.log(json({ mode: "SCHEMA_PREFLIGHT", availableOwnershipTables: metadata,
      missingExpectedTables: ["holdings", "fund_holdings", "institutional_holdings"].filter(table => !available.has(table)) }));
    return;
  }
  const before = await summary();
  if (!apply) return console.log(json({ mode: "AUDIT", before }));
  const result = await prisma.$transaction(async tx => ({
    sharedHoldingRowsUpdated: await remap(tx, "holdings"),
    fundRowsUpdated: await remap(tx, "fund_holdings"),
    institutionalRowsUpdated: await remapInstitutional(tx),
  }), { timeout: 30_000 });
  const after = await summary();
  const state = { status: "COMPLETE", processId: process.pid, completedAt: new Date().toISOString(), result, before, after };
  await checkpoint(state); console.log(json(state));
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
