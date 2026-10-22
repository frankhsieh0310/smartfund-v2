const { createHash } = require("node:crypto");
const { mkdir, open, readFile, rename, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const RUNTIME_ROOT = path.resolve("runtime", "bond", "professional-depth");
const CHECKPOINT_PATH = path.join(RUNTIME_ROOT, "checkpoint.json");
const COVERAGE_PATH = path.join(RUNTIME_ROOT, "coverage.json");
const DETAIL_CONTRACT_PATH = path.join(RUNTIME_ROOT, "deterministic-detail-sample.json");
const PRODUCT_CONTRACT_PATH = path.join(RUNTIME_ROOT, "product-data-contracts.json");
const LOCK_PATH = path.join(RUNTIME_ROOT, "worker.lock.json");
const limitArg = process.argv.find((value) => value.startsWith("--limit="));
const LIMIT = Math.min(Math.max(Number.parseInt(limitArg?.slice(8) ?? "100", 10), 1), 200);

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

function deterministicId(namespace, value) {
  const hex = createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function identifier(row) {
  if (row.isin) return { type: "ISIN", value: row.isin };
  if (row.cusip) return { type: "CUSIP", value: row.cusip };
  if (row.sedol) return { type: "SEDOL", value: row.sedol };
  return { type: "EXISTING_TICKER", value: row.ticker };
}

function taxonomy(row) {
  const text = `${row.sector ?? ""} ${row.industry ?? ""}`.toUpperCase();
  if (/MUNICIPAL|CITY|LOCAL GOVERNMENT|市政府/.test(text)) return "MUNICIPAL";
  if (/GOVERNMENT|TREASURY|SOVEREIGN|JGB|央債|FEDERAL/.test(text)) return "GOVERNMENT";
  return "UNKNOWN";
}

function governmentSubtype(row) {
  const text = `${row.sector ?? ""} ${row.industry ?? ""}`.toUpperCase();
  if (/INFLATION|TIPS/.test(text)) return "INFLATION_LINKED";
  if (/TREASURY_BILL|\bBILL\b/.test(text)) return "BILL";
  if (/\bNOTE\b/.test(text)) return "NOTE";
  if (/\bBOND\b|JGB|FEDERAL BONDS|央債/.test(text)) return "BOND";
  if (/MUNICIPAL|CITY|LOCAL GOVERNMENT|市政府/.test(text)) return "LOCAL_GOVERNMENT";
  if (/TREASURY/.test(text)) return "TREASURY";
  if (/SOVEREIGN|GOVERNMENT|FEDERAL/.test(text)) return "SOVEREIGN";
  return "UNKNOWN";
}

async function acquireLock() {
  await mkdir(RUNTIME_ROOT, { recursive: true });
  const handle = await open(LOCK_PATH, "wx");
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
  return handle;
}

async function mapBatch() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT s.id, s.ticker, s.isin, s.cusip, s.sedol, s.name, s.country, s.currency, s.sector, s.industry
    FROM securities s
    LEFT JOIN bond_security_links l ON l.security_id = s.id
    WHERE l.security_id IS NULL
      AND (s.industry ILIKE '%bond%' OR s.sector ILIKE '%sovereign%' OR s.sector ILIKE '%treasury%')
    ORDER BY s.id
    LIMIT $1
  `, LIMIT);
  for (const row of rows) {
    const id = identifier(row);
    const bondId = deterministicId("bond", row.id);
    const issuerName = row.sector || `UNKNOWN_ISSUER_${row.country}`;
    const issuerId = deterministicId("bond-issuer", `${row.country}:${issuerName}`);
    const issuerType = taxonomy(row) === "MUNICIPAL" ? "LOCAL_GOVERNMENT" : "SOVEREIGN_GOVERNMENT";
    const subtype = governmentSubtype(row);
    const taxon = taxonomy(row);
    const inflationLinked = subtype === "INFLATION_LINKED" ? true : null;
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`INSERT INTO bond_issuers (id, official_name, issuer_type, country, verification_status, source_id)
        VALUES ($1,$2,$3,$4,'VERIFIED_EXISTING','SECURITIES_SECTOR') ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`, issuerId, issuerName, issuerType, row.country),
      prisma.$executeRawUnsafe(`INSERT INTO bond_instruments
        (id,security_id,issuer_id,source_namespace,official_security_id,official_name,instrument_type,taxonomy,government_subtype,identifier_type,identifier_value,isin,cusip,sedol,country,jurisdiction,currency,status,source_id,verification_status,mapping_type)
        VALUES ($1,$2,$3,'EXISTING_SECURITY_CANONICAL',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,'UNKNOWN','SECURITIES','VERIFIED_EXISTING','VERIFIED_EXISTING')
        ON CONFLICT (security_id) DO UPDATE SET official_name=EXCLUDED.official_name, issuer_id=EXCLUDED.issuer_id, last_seen_at=NOW(), updated_at=NOW()`,
        bondId,row.id,issuerId,row.id,row.name,row.industry || "UNKNOWN",taxon,subtype,id.type,id.value,row.isin,row.cusip,row.sedol,row.country,row.currency),
      prisma.$executeRawUnsafe(`INSERT INTO bond_security_links (id,security_id,bond_id,mapping_type,identifier_type,identifier_value,verification_status)
        VALUES ($1,$2,$3,'VERIFIED_EXISTING',$4,$5,'VERIFIED_EXISTING') ON CONFLICT (security_id) DO UPDATE SET updated_at=NOW()`, deterministicId("bond-link", row.id),row.id,bondId,id.type,id.value),
      prisma.$executeRawUnsafe(`INSERT INTO bond_terms (id,bond_id,coupon_type,currency,inflation_linked,source_id,verification_status)
        VALUES ($1,$2,$3,$4,$5,'SECURITIES','VERIFIED_EXISTING') ON CONFLICT (bond_id) DO UPDATE SET updated_at=NOW()`, deterministicId("bond-terms", row.id),bondId,inflationLinked ? "INFLATION_LINKED" : "UNKNOWN",row.currency,inflationLinked),
      prisma.$executeRawUnsafe(`INSERT INTO bond_freshness (id,bond_id,freshness_status,source_status)
        VALUES ($1,$2,'UNKNOWN','SOURCE_PENDING') ON CONFLICT (bond_id) DO NOTHING`, deterministicId("bond-freshness", row.id),bondId),
    ]);
  }
  return rows.length;
}

async function reconcileObservations() {
  return prisma.$executeRawUnsafe(`UPDATE bond_market_observations o SET bond_id=i.id,
    currency=COALESCE(o.currency,i.currency), verification_status='VERIFIED_EXISTING',
    checksum=COALESCE(o.checksum,md5(o.source_namespace||':'||o.official_series_id||':'||o.observation_date::text||':'||o.observation_type||':'||o.value::text))
    FROM bond_instruments i WHERE i.security_id=o.security_id AND o.bond_id IS DISTINCT FROM i.id`);
}

async function isolateBenchmarks() {
  const rows = await prisma.$queryRawUnsafe(`SELECT m.id,m.symbol,m.name,m.currency,m.provider,m.latest_date,
    COUNT(h.*)::int history_rows,MIN(h.date) start_date,MAX(h.date) end_date,
    COUNT(*) FILTER(WHERE h.close=0)::int unexpected_zeros,
    (COUNT(*)-COUNT(DISTINCT h.date))::int duplicate_dates
    FROM market_master m LEFT JOIN market_history h ON h.symbol=m.symbol
    WHERE m.asset_type::text='BOND' GROUP BY m.id,m.symbol,m.name,m.currency,m.provider,m.latest_date ORDER BY m.symbol`);
  for (const row of rows) {
    const tenor = row.symbol.match(/US(\d+)([YWM])/)?.slice(1).join("") ?? null;
    const quality = row.start_date && new Date(row.start_date).toISOString().slice(0,10) === "1970-01-02" ? "INVALID_START_RANGE" : row.duplicate_dates ? "DUPLICATE_DATES" : "PASS";
    await prisma.$executeRawUnsafe(`INSERT INTO bond_benchmark_series
      (id,market_master_id,symbol,official_name,country,currency,benchmark_type,tenor,provider,source_id,start_date,latest_date,verification_status,history_quality_status,history_rows,duplicate_dates,unexpected_zeros)
      VALUES ($1,$2,$3,$4,'US',$5,'GOVERNMENT_YIELD',$6,$7,'MARKET_MASTER',$8,$9,'PROVIDER_RECORDED',$10,$11,$12,$13)
      ON CONFLICT (symbol) DO UPDATE SET start_date=EXCLUDED.start_date,latest_date=EXCLUDED.latest_date,history_quality_status=EXCLUDED.history_quality_status,history_rows=EXCLUDED.history_rows,duplicate_dates=EXCLUDED.duplicate_dates,unexpected_zeros=EXCLUDED.unexpected_zeros,updated_at=NOW()`,
      deterministicId("bond-benchmark",row.symbol),row.id,row.symbol,row.name,row.currency,tenor,row.provider,row.start_date,row.end_date,quality,row.history_rows,row.duplicate_dates,row.unexpected_zeros);
  }
}

async function refreshCoverage() {
  await prisma.$executeRawUnsafe(`INSERT INTO bond_coverage_snapshots
    (id,snapshot_date,country,total_bond_identities,verified_canonical,terms_covered,current_covered,history_covered,ge_1y,ge_5y,ge_10y,source_blocked,license_blocked,identity_ready,terms_ready,current_ready,history_ready,source_ready,freshness_ready,analytics_ready,professional_detail_ready,missing_reasons)
    SELECT md5('bond-coverage:'||CURRENT_DATE::text||':'||s.country),CURRENT_DATE,s.country,COUNT(DISTINCT s.id)::int,COUNT(DISTINCT i.id)::int,
      COUNT(DISTINCT t.bond_id) FILTER(WHERE t.issue_date IS NOT NULL OR t.maturity_date IS NOT NULL OR t.coupon_rate IS NOT NULL)::int,
      COUNT(DISTINCT o.bond_id)::int,0,0,0,0,0,0,COUNT(i.id)=COUNT(*),false,COUNT(DISTINCT o.bond_id)=COUNT(*),false,false,false,false,false,
      jsonb_build_array('TERMS_INCOMPLETE','CURRENT_OBSERVATION_INCOMPLETE','INSTRUMENT_HISTORY_MISSING','ANALYTICS_MISSING')
    FROM securities s LEFT JOIN bond_instruments i ON i.security_id=s.id LEFT JOIN bond_terms t ON t.bond_id=i.id LEFT JOIN bond_market_observations o ON o.bond_id=i.id
    WHERE s.industry ILIKE '%bond%' OR s.sector ILIKE '%sovereign%' OR s.sector ILIKE '%treasury%'
    GROUP BY s.country ON CONFLICT (snapshot_date,country) DO UPDATE SET verified_canonical=EXCLUDED.verified_canonical,terms_covered=EXCLUDED.terms_covered,current_covered=EXCLUDED.current_covered,updated_at=NOW()`);
  const coverage = await prisma.$queryRawUnsafe(`SELECT COUNT(DISTINCT s.id)::int total_eligible,COUNT(DISTINCT i.id)::int verified_links,
    (COUNT(DISTINCT s.id)-COUNT(DISTINCT i.id))::int unresolved_links,COUNT(DISTINCT o.bond_id)::int observed_instruments,
    COUNT(DISTINCT t.bond_id) FILTER(WHERE t.maturity_date IS NOT NULL)::int maturity_covered,COUNT(DISTINCT t.bond_id) FILTER(WHERE t.coupon_rate IS NOT NULL)::int coupon_covered
    FROM securities s LEFT JOIN bond_instruments i ON i.security_id=s.id LEFT JOIN bond_terms t ON t.bond_id=i.id LEFT JOIN bond_market_observations o ON o.bond_id=i.id
    WHERE s.industry ILIKE '%bond%' OR s.sector ILIKE '%sovereign%' OR s.sector ILIKE '%treasury%'`);
  await writeJsonAtomic(COVERAGE_PATH, { generatedAt: new Date().toISOString(), ...coverage[0] });
  return coverage[0];
}

async function writeContracts() {
  const sample = await prisma.$queryRawUnsafe(`SELECT i.id canonical_bond_id,i.official_name,i.identifier_type,i.identifier_value,i.isin,i.cusip,i.country,i.currency,i.taxonomy,i.government_subtype,
    u.official_name issuer,t.issue_date,t.maturity_date,t.coupon_rate,t.coupon_type,
    MAX(o.observation_date) latest_observation_date,COUNT(o.id)::int observation_count,f.freshness_status
    FROM bond_instruments i LEFT JOIN bond_issuers u ON u.id=i.issuer_id LEFT JOIN bond_terms t ON t.bond_id=i.id LEFT JOIN bond_market_observations o ON o.bond_id=i.id LEFT JOIN bond_freshness f ON f.bond_id=i.id
    GROUP BY i.id,u.official_name,t.issue_date,t.maturity_date,t.coupon_rate,t.coupon_type,f.freshness_status ORDER BY md5(i.id) LIMIT 10`);
  await writeJsonAtomic(DETAIL_CONTRACT_PATH, { generatedAt: new Date().toISOString(), sample });
  await writeJsonAtomic(PRODUCT_CONTRACT_PATH, {
    version: 1,
    detail: ["identity","issuer","terms","latest","history","benchmark","spread","risk","rating","source","freshness","missingReasons"],
    search: ["name","identifier","isin","issuer","country","currency","maturity","bondType"],
    semantics: { instrumentVsBenchmark: "STRICTLY_SEPARATED", couponVsYield: "STRICTLY_SEPARATED", nullPolicy: "UNKNOWN_OR_NULL_NEVER_ZERO" },
  });
}

async function main() {
  if (!process.argv.includes("--resume")) throw new Error("BOND_P0_REQUIRES_RESUME");
  const lock = await acquireLock();
  try {
    const checkpoint = await readJson(CHECKPOINT_PATH, { status: "READY", processed: 0, startedAt: new Date().toISOString() });
    const mapped = await mapBatch();
    const reconciled = await reconcileObservations();
    await isolateBenchmarks();
    const coverage = await refreshCoverage();
    await writeContracts();
    checkpoint.processed = coverage.verified_links;
    checkpoint.totalEligible = coverage.total_eligible;
    checkpoint.remaining = coverage.unresolved_links;
    checkpoint.lastBatch = mapped;
    checkpoint.observationsReconciled = reconciled;
    checkpoint.status = coverage.unresolved_links === 0 ? "COMPLETE" : "CONTINUING";
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
    console.log(JSON.stringify({ type: "BOND_P0_DEPTH_RECOVERY", ...checkpoint }));
  } finally {
    await prisma.$disconnect();
    await lock.close().catch(() => undefined);
    await unlink(LOCK_PATH).catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
